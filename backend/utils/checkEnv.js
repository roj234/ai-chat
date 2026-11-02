import os from "node:os";
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {promisify} from "node:util";
import {exec} from "node:child_process";
import {safeStat} from "@roj234/ie/utils/serveFile.js";
import {sleep} from "../../common/pure-utils.js";

const execPromise = promisify(exec);

/**
 * 异步执行命令，带超时
 * @param {string} cmd 要执行的命令
 * @returns {Promise<{ success: boolean, output?: string, error?: string }>}
 */
async function execCommand(cmd) {
	try {
		const options = {
			encoding: 'utf8',
			timeout: 5000
		};
		const { stdout, stderr } = await execPromise(cmd, options);
		// 有些工具（如 java -version）输出在 stderr，合并处理并提取第一行
		const output = (stdout + stderr).trim().split('\n')[0];
		return { success: true, output };
	} catch (err) {
		let errorMsg = '';
		if (err.killed) {
			errorMsg = 'timeout';
		} else {
			errorMsg = err.stderr ? err.stderr.toString().trim() : err.message;
		}
		return { success: false, error: errorMsg };
	}
}

/**
 * 并发收集各工具版本信息
 */
async function detectEnv() {
	// 并不是我歧视谁，而是LLM常用的脚本语言不就 node 和 python，最多再加一个 cpp，你看我最爱的 java 都没写 —— 反正LLM自己能检查
	let [
		gitResult,
		bashResult,
		bashMSYSResult,
		python3Result,
		pythonResult,
		npmResult,
		cppResult,
	] = await Promise.all([
		'git --version',
		'bash --help',
		'bash -c "cmd /c echo /"',
		'python3 --version',
		'python --version',
		'npm --version',
		'g++ --version',
	].map(execCommand));

	const env = {};

	env.os = `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`;
	env.node = process.version;  // Node 版本可直接获取

	env.npm = npmResult.success ? npmResult.output : 'Not found';

	const simplePattern = /^[a-zA-Z]+\s+(?:version\s+)?("?)(\S+\1)/;
	const commonMatch = result => result.success ? result.output.match(simplePattern)?.[2] || result.output : "Not found";

	env.git = commonMatch(gitResult);

	if (bashResult.success) {
		const match = bashResult.output.match(/^(BusyBox v[\d.]+)/);
		env.bash = match ? match[1] : bashResult.output;
		if (os.platform() === 'win32') {
			env.bashDialect = !bashMSYSResult.success
				? "unknown, probe double slashes and absolute path format first"
				: bashMSYSResult.output === '/'
					? "Busybox: Windows commands use **single** slashes (`cmd /c`) and absolute path is Windows-like (`C:/Windows/System32/`)"
					: "MSYS: Windows commands use **double** slashes (`cmd //c`) and absolute path is unix-like (`/cygdrive/c/Windows/System32/`)";
		}
	} else {
		env.bash = 'Not found';
	}

	if (python3Result.success) env.python = commonMatch(python3Result);
	else if (pythonResult.success) env.python = commonMatch(pythonResult);
	else env.python = 'Not found';

	if (cppResult.success) {
		env['c/cpp'] = cppResult.output.match(simplePattern)?.[0] || cppResult.output;
	} else {
		const clangResult = await execCommand('clang++ --version');
		env['c/cpp'] = clangResult.success ? clangResult.output.match(simplePattern)?.[0] || clangResult.output : 'Not found';
	}

	return env;
}

let prompt;
export async function getEnvironmentPrompt(forceRecheck) {
	if (!prompt || forceRecheck) {
		console.log("正在检测环境，稍等");

		prompt = '';
		for (const [tool, version] of Object.entries(await detectEnv())) {
			prompt += `${tool}: ${version}\n`;
		}
		prompt = prompt.trim();
	}

	return prompt;
}

const DOWNLOAD_URL = 'https://frippery.org/files/busybox/busybox64u.exe';

const log = (...a) => console.log(...a);

const BIN_DIR = path.resolve(path.join(import.meta.dirname, 'bin'));
const TARGET = path.join(BIN_DIR, 'bash.exe');

/** 改名（Windows 上被占用的 exe 会 EPERM/EBUSY，重试） */
async function renameWithRetry(from, to, timeoutMs = 1500) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await fsp.rename(from, to);
			return true;
		} catch (e) {
			if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(e.code) || Date.now() > deadline) throw e;
			await sleep(120);
		}
	}
}

export async function updateBash() {
	if (process.platform !== 'win32') return;

	await fsp.mkdir(BIN_DIR, {recursive: true});

	const TEMP_FILE = TARGET+".tmp";
	const tmpStat = await safeStat(TEMP_FILE);

	if (tmpStat.size > 0) {
		await renameWithRetry(TEMP_FILE, TARGET);
		prompt = null;
		log("[update-bash] busybox-w32 已更新");
	}

	const stat = await safeStat(TARGET);
	const ac = new AbortController;

	const timeout = setTimeout(() => ac.abort(), 10000);

	const res = await fetch(DOWNLOAD_URL, {
		method: 'GET',
		redirect: 'follow',
		headers: stat.mtime ? { 'If-Modified-Since': `${stat.mtime.toUTCString()}`, } : undefined,
		signal: ac.signal,
	}).catch(() => {});

	if (!res?.ok) {
		if (res?.status === 304) log("[update-bash] 无更新");
		else log("[update-bash] 网络错误", res);
		return;
	}

	clearTimeout(timeout);

	const date = Date.parse(res.headers.get('last-modified')) / 1000 || null;
	const length = parseInt(res.headers.get('content-length')) || null;
	let downloaded = 0;

	if (length > 1048576) throw new Error("[update-bash] 新版本太大");

	const reader = res.body.getReader();
	const handle = await fsp.open(TEMP_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);

	while (true) {
		const {done, value} = await reader.read();
		if (done) break;

		await handle.write(value);

		downloaded += value.length;
		if (length) {
			const pct = Math.floor(downloaded / length * 100);
			if (pct % 10 === 0) process.stdout.write(`\r  busybox-w32 下载中… ${pct}% (${(downloaded / 1048576).toFixed(2)} MB)`);
		}

		if (downloaded > 1048576) {
			await handle.close();
			await fsp.rm(TEMP_FILE);

			throw new Error("[update-bash] 新版本太大");
		}
	}

	if (date != null) await handle.utimes(date, date);
	await handle.close();

	log('');
	await renameWithRetry(TEMP_FILE, TARGET).catch(e => log(`[update-bash] bash.exe 正在使用，将在重启后更新`));

	prompt = null;
	log("[update-bash] busybox-w32 已更新");
}
