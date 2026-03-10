
/**
 * 判断给定的 URL 或主机名是否为局域网/私有网络地址
 * @param {string} input - 完整的 URL 或域名/IP
 * @returns {boolean}
 */
export function isLanAddress(input) {
	try {
		let hostname;
		try {
			// 尝试作为 URL 解析
			hostname = new URL(input).hostname;
		} catch (e) {
			// 如果不是有效 URL，可能只是纯域名或 IP
			hostname = input;
		}

		// 1. 处理常见本地主机名
		if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
			return true;
		}

		// 2. 处理 mDNS (Apple Bonjour / ZeroConf)
		if (hostname.endsWith('.local')) {
			return true;
		}

		// 3. 检查是否为 IPv4 地址
		const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
		const match = hostname.match(ipv4Pattern);

		if (match) {
			const [, octet1, octet2, octet3, octet4] = match.map(Number);

			// RFC 1918 私有地址范围
			// 10.0.0.0 - 10.255.255.255
			if (octet1 === 10) return true;

			// 172.16.0.0 - 172.31.255.255
			if (octet1 === 172 && (octet2 >= 16 && octet2 <= 31)) return true;

			// 192.168.0.0 - 192.168.255.255
			if (octet1 === 192 && octet2 === 168) return true;

			// 169.254.0.0 - 169.254.255.255 (Link-local)
			if (octet1 === 169 && octet2 === 254) return true;

			// 127.0.0.0/8 (Loopback)
			if (octet1 === 127) return true;
		}

		// 4. 检查 IPv6 私有地址 (简易识别)
		// fc00::/7 (Unique Local Address) 或 fe80::/10 (Link-local)
		if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) {
			return true;
		}

		return false;
	} catch (err) {
		return false;
	}
}