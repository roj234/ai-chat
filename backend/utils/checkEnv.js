import os from "node:os";
import {promisify} from "node:util";
import {exec} from "node:child_process";

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
			timeout: 2000
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
		python3Result,
		pythonResult,
		npmResult,
		cppResult,
	] = await Promise.all([
		'git --version',
		'bash --help',
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
		prompt = '';
		for (const [tool, version] of Object.entries(await detectEnv())) {
			prompt += `${tool}: ${version}\n`;
		}
		prompt = prompt.trim();
	}

	return prompt;
}