// SOCKS5 Proxy Agent for Node.js native fetch / http / https
// Pure Node.js — no external dependencies.
//
// Usage with fetch (factory — protocol auto-detect, URL parsed):
//   import { createSocks5Agent } from './socks5-agent.js';
//   const getAgent = createSocks5Agent(
//     'socks5://127.0.0.1:1080',
//     { keepAlive: true },
//   );
//   // or with auth:  createSocks5Agent('socks5://user:pass@host:port', agentOptions)
//   await fetch('https://example.com', { agent: getAgent });
//
// Usage with fetch (manual):
//   import { Socks5HttpAgent, Socks5HttpsAgent } from './socks5-agent.js';
//   await fetch('https://example.com', {
//     agent: new Socks5HttpsAgent({ proxyHost: '127.0.0.1' })
//   });
//
// Usage with http/https modules:
//   import https from 'node:https';
//   https.request({ hostname: 'example.com', agent: new Socks5HttpsAgent({...}) });

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

// ─── helpers ────────────────────────────────────────────────────────────────

const SOCKS5_ERRORS = Object.freeze(Object.assign(Object.create(null), {
	1: 'general SOCKS server failure',
	2: 'connection not allowed by ruleset',
	3: 'Network unreachable',
	4: 'Host unreachable',
	5: 'Connection refused',
	6: 'TTL expired',
	7: 'Command not supported',
	8: 'Address type not supported',
}));

/** Parse an IPv6 string into 16 raw bytes.  Handles :: compression. */
function parseIPv6(raw) {
	// strip zone ID (e.g. fe80::1%eth0)
	const pct = raw.indexOf('%');
	const ip = pct >= 0 ? raw.substring(0, pct).toLowerCase() : raw.toLowerCase();

	// expand :: into the appropriate number of zero segments
	if (ip.includes('::')) {
		const [left, right] = ip.split('::');
		const la = left ? left.split(':').filter(Boolean) : [];
		const ra = right ? right.split(':').filter(Boolean) : [];
		const missing = 8 - la.length - ra.length;
		if (missing < 0) throw new Error(`Invalid IPv6: ${raw}`);
		const full = [...la, ...Array(missing).fill('0'), ...ra];
		const bytes = Buffer.alloc(16);
		for (let i = 0; i < 8; i++) {
			// each segment is 16 bits, big-endian
			const v = parseInt(full[i], 16) & 0xffff;
			bytes[i * 2] = (v >> 8) & 0xff;
			bytes[i * 2 + 1] = v & 0xff;
		}
		return bytes;
	}

	// no :: – must have exactly 8 segments
	const parts = ip.split(':');
	if (parts.length !== 8) throw new Error(`Invalid IPv6: ${raw}`);
	const bytes = Buffer.alloc(16);
	for (let i = 0; i < 8; i++) {
		const v = parseInt(parts[i], 16) & 0xffff;
		bytes[i * 2] = (v >> 8) & 0xff;
		bytes[i * 2 + 1] = v & 0xff;
	}
	return bytes;
}

/**
 * Build the address field for a SOCKS5 CONNECT request.
 * Returns { atyp, addr } — atyp is the address-type byte, addr is a Buffer.
 */
function buildSocks5Address(host) {
	const ipType = net.isIP(host);
	if (ipType === 4) {
		// IPv4
		return {
			atyp: 0x01,
			addr: Buffer.from(host.split('.').map((n) => parseInt(n, 10) & 0xff)),
		};
	}
	if (ipType === 6) {
		// IPv6
		return { atyp: 0x04, addr: parseIPv6(host) };
	}
	// Domain name
	const name = Buffer.from(host, 'ascii');
	const buf = Buffer.alloc(1 + name.length);
	buf[0] = name.length;
	name.copy(buf, 1);
	return { atyp: 0x03, addr: buf };
}

/**
 * Perform a SOCKS5 CONNECT handshake on `socket` to `targetHost:targetPort`.
 * The socket should already be connecting / connected to the SOCKS5 proxy.
 *
 * When the handshake finishes successfully, `callback(null, socket)` is called.
 * Any data received from the target *after* the SOCKS5 reply is unshifted back
 * onto the socket.
 */
function socks5Connect(socket, targetHost, targetPort, username, password, callback) {
	/**
	 * State machine:
	 *   0 – waiting for server auth-method selection
	 *   1 – waiting for username/password auth reply
	 *   2 – waiting for CONNECT reply
	 */
	let state = 0;
	let buf = Buffer.alloc(0);

	const fail = (err) => {
		// guard against double-callback (e.g. error after handshake-done)
		if (state === 3) return;
		state = 3;
		socket.removeAllListeners();
		socket.destroy();
		callback(err);
	};

	// ── send methods ──────────────────────────────────────────────────────

	const sendGreeting = () => {
		const methods = username != null ? [0x00, 0x02] : [0x00];
		const msg = Buffer.alloc(2 + methods.length);
		msg[0] = 0x05;
		msg[1] = methods.length;
		for (let i = 0; i < methods.length; i++) msg[2 + i] = methods[i];
		socket.write(msg);
	};

	const sendAuth = () => {
		const u = Buffer.from(username, 'utf8');
		const p = Buffer.from(password ?? '', 'utf8');
		const msg = Buffer.alloc(3 + u.length + p.length);
		msg[0] = 0x01; // sub-negotiation version
		msg[1] = u.length;
		u.copy(msg, 2);
		msg[2 + u.length] = p.length;
		p.copy(msg, 3 + u.length);
		socket.write(msg);
	};

	const sendConnect = () => {
		const { atyp, addr } = buildSocks5Address(targetHost);
		const msg = Buffer.alloc(4 + addr.length + 2);
		msg[0] = 0x05; // VER
		msg[1] = 0x01; // CMD = CONNECT
		msg[2] = 0x00; // RSV
		msg[3] = atyp;
		addr.copy(msg, 4);
		msg[4 + addr.length] = (targetPort >> 8) & 0xff;
		msg[5 + addr.length] = targetPort & 0xff;
		socket.write(msg);
	};

	// ── events ────────────────────────────────────────────────────────────

	socket.on('error', fail);

	// If socket is already connected (rare), send greeting immediately.
	// Otherwise wait for 'connect'.
	if (socket.readyState === 'open') {
		sendGreeting();
	} else {
		socket.once('connect', sendGreeting);
	}

	socket.on('data', (chunk) => {
		buf = Buffer.concat([buf, chunk]);

		if (state === 0) {
			// greeting reply — [ver, method]
			if (buf.length < 2) return;
			const ver = buf[0];
			const method = buf[1];
			buf = buf.subarray(2);

			if (ver !== 0x05) return fail(new Error(`SOCKS5: unexpected version ${ver}`));
			if (method === 0xff) return fail(new Error('SOCKS5: no acceptable authentication method'));

			if (method === 0x00) {
				sendConnect();
				state = 2;
			} else if (method === 0x02) {
				sendAuth();
				state = 1;
			} else {
				return fail(new Error(`SOCKS5: unsupported auth method ${method}`));
			}
		} else if (state === 1) {
			// auth reply — [ver(0x01), status]
			if (buf.length < 2) return;
			if (buf[0] !== 0x01) return fail(new Error('SOCKS5: unexpected auth reply version'));
			if (buf[1] !== 0x00) return fail(new Error('SOCKS5: authentication failed'));
			buf = buf.subarray(2);
			sendConnect();
			state = 2;
		} else if (state === 2) {
			// CONNECT reply — [ver, rep, rsv, atyp, …]
			if (buf.length < 4) return;
			const rep = buf[1];
			const atyp = buf[3];

			let total;
			switch (atyp) {
				case 0x01: total = 4 + 4 + 2; break;          // IPv4
				case 0x04: total = 4 + 16 + 2; break;         // IPv6
				case 0x03:                                     // Domain name
					if (buf.length < 5) return;
					total = 4 + 1 + buf[4] + 2;
					break;
				default:
					return fail(new Error(`SOCKS5: unknown address type ${atyp}`));
			}

			if (buf.length < total) return;

			if (rep !== 0x00) {
				return fail(new Error(`SOCKS5: ${SOCKS5_ERRORS[rep] ?? `error ${rep}`}`));
			}

			// ── handshake complete ──────────────────────────────────────
			state = 3;
			socket.removeAllListeners();

			// push back any data that arrived *after* the SOCKS5 reply
			const leftover = buf.subarray(total);
			if (leftover.length > 0) socket.unshift(leftover);

			callback(null, socket);
		}
	});
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a function suitable for `fetch(url, { agent: fn })`.
 *
 * The returned function receives a parsed URL and returns the appropriate
 * SOCKS5 agent instance (Socks5HttpAgent / Socks5HttpsAgent).  Both agents
 * share the same proxy config and the same keep-alive / pool settings.
 *
 * @param {string|URL} proxyUrl   SOCKS5 proxy URL, e.g. 'socks5://127.0.0.1:1080'
 *                                or 'socks5://user:pass@host:port'
 * @param {Object} [agentOptions] Standard http.Agent options
 *        (keepAlive, keepAliveMsecs, maxSockets, scheduling, …)
 * @returns {function(URL): (Socks5HttpAgent|Socks5HttpsAgent)}
 */
export function createSocks5Agent(proxyUrl, agentOptions) {
	const parsed = new URL(proxyUrl);

	const proxyHost = parsed.hostname;
	const proxyPort = Number(parsed.port) || 1080;
	const username = parsed.username || null;
	const password = parsed.password || null;

	let httpAgent;
	let httpsAgent;

	const getOrCreate = (AgentClass) => {
		return new AgentClass({ proxyHost, proxyPort, username, password, ...agentOptions });
	};

	return function getFetchAgent(parsedURL) {
		if (parsedURL.protocol === 'https:') {
			return (httpsAgent ??= getOrCreate(Socks5HttpsAgent));
		}
		return (httpAgent ??= getOrCreate(Socks5HttpAgent));
	};
}

// ─── Agent classes ──────────────────────────────────────────────────────────

/**
 * SOCKS5 agent for **HTTP** requests.
 *
 * extendable options (in addition to standard http.Agent options):
 *   proxyHost      – SOCKS5 proxy hostname or IP   (default '127.0.0.1')
 *   proxyPort      – SOCKS5 proxy port             (default 1080)
 *   username       – SOCKS5 username (optional)
 *   password       – SOCKS5 password (optional)
 */
export class Socks5HttpAgent extends http.Agent {
	#proxyHost;
	#proxyPort;
	#username;
	#password;

	constructor(options = {}) {
		const { proxyHost, proxyPort, username, password, ...rest } = options;
		super(rest);
		this.#proxyHost = proxyHost ?? '127.0.0.1';
		this.#proxyPort = proxyPort ?? 1080;
		this.#username = username ?? null;
		this.#password = password ?? null;
	}

	/**
	 * Override http.Agent.createConnection.
	 *
	 * Called by the agent with (options, callback).  We connect to the SOCKS5
	 * proxy, perform the handshake, then pass the tunneled socket to the callback.
	 *
	 * Return `null` to signal async completion.
	 */
	createConnection(options, callback) {
		const socket = net.createConnection({
			host: this.#proxyHost,
			port: this.#proxyPort,
		});

		socks5Connect(
			socket,
			options.host,     // target host (may be hostname or IP)
			options.port,     // target port
			this.#username,
			this.#password,
			callback,
		);

		return null; // async – agent waits for callback
	}
}

/**
 * SOCKS5 agent for **HTTPS** requests.
 *
 * Same constructor options as Socks5HttpAgent.
 *
 * After the SOCKS5 CONNECT tunnel is established, this agent immediately
 * performs a TLS handshake on top of it, so the returned socket is a
 * `tls.TLSSocket` ready for HTTPS traffic.
 */
export class Socks5HttpsAgent extends https.Agent {
	#proxyHost;
	#proxyPort;
	#username;
	#password;

	constructor(options = {}) {
		const { proxyHost, proxyPort, username, password, ...rest } = options;
		super(rest);
		this.#proxyHost = proxyHost ?? '127.0.0.1';
		this.#proxyPort = proxyPort ?? 1080;
		this.#username = username ?? null;
		this.#password = password ?? null;
	}

	createConnection(options, callback) {
		const proxySocket = net.createConnection({
			host: this.#proxyHost,
			port: this.#proxyPort,
		});

		socks5Connect(proxySocket, options.host, options.port, this.#username, this.#password, (err) => {
			if (err) return callback(err);

			// SOCKS5 tunnel established — now wrap with TLS
			const tlsSocket = tls.connect({
				socket: proxySocket,
				servername: options.servername ?? options.host,
			});

			tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
			tlsSocket.once('error', (e) => {
				tlsSocket.destroy();
				callback(e);
			});
		});

		return null; // async
	}
}
