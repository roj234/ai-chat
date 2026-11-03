import iconv from "iconv-lite";
import {spawn} from "node:child_process";
import {killProcess} from "../utils/process.js";

/**
 * @param {AiChatBackend.Router} router
 */
export function registerTerminalRoutes(router) {
	router.get('/terminal',  (ctx) => ctx.send(204));
	const instances = new Map;

	router.post('/terminal', async (ctx) => {
		let {
			id,
			shell = process.platform === 'win32' ? "cmd" : "bash",
			charset = process.platform === 'win32' ? "gbk" : "utf8",
			cwd = process.cwd(),
			env,
		} = await ctx.readAsObject();

		if (typeof id !== 'string') return ctx.send(400, { error: 'id not string' });

		const send = (kind, line) => {
			if (!ctx.res.writableEnded && !ctx.res.closed)
				ctx.res.write(`data: `+kind+line+'\n\n');
		};
		const sendEnd = () => {
			if (!ctx.res.writableEnded && !ctx.res.closed)
				ctx.res.end(`data: [DONE]\n\n`);
		}

		let child = spawn(shell, [], {
			cwd,
			env: {
				Path: process.env.Path,
				...env
			},
			encoding: null,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		});

		let buf = '';

		const stdoutStr = iconv.decodeStream(charset);
		const stderrStr = iconv.decodeStream(charset);
		const stdinStr = iconv.encodeStream(charset);

		child.stdout.pipe(stdoutStr);
		child.stderr.pipe(stderrStr);
		stdinStr.pipe(child.stdin);

		instances.set(id, {
			child,
			stdin: stdinStr
		});
		console.log("[terminal] "+id+" started", shell);

		stdoutStr.on('data', (data) => {
			buf += data;
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const line of lines) send('O', line);
			if (buf) send('L', buf);
		});

		stderrStr.on('data', (data) => {
			buf += data;
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const line of lines) send('E', line);
			if (buf) send('L', buf);
		});

		ctx.res.once('close', () => {
			killProcess(child);
		});

		child.on('close', (code) => {
			console.log("[terminal] "+id+" end");

			send('E', `--- Process exited with code ${code} at ${new Date().toISOString()} ---`);
			instances.delete(id);
			sendEnd();
		});

		child.on('error', (err) => {
			send('E', `--- Process error: ${JSON.stringify(err.message)} ---`);
			instances.delete(id);
			sendEnd();
		});

		ctx.res.writeHead(200, {'Content-Type': 'text/event-stream',});
		send('E', `--- Process ${shell} started at ${new Date().toISOString()} ---`);
	});
	router.post('/terminalWrite', async (ctx) => {
		const {
			id,
			content
		} = await ctx.readAsObject();

		const thr = instances.get(id);
		if (!thr) return ctx.send(404);

		console.log("[terminal] "+id+" write", JSON.stringify(content));
		thr.stdin.write(content);
		return ctx.send(204);
	});
}