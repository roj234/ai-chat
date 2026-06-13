import os from "os";
import {promisify} from "util";
import {exec} from "child_process";

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
	let [
		gitResult,
		bashResult,
		python3Result,
		pythonResult,
		javaResult,
		npmResult,
		dockerResult,
		cppResult,
		goResult,
		rustResult,
		dotnetResult,
		rubyResult,
		phpResult,
		perlResult,
		swiftResult,
		kotlinResult,
		tscResult,
		dartResult,
		ripgrepResult
	] = await Promise.all([
		'git --version',
		'bash --help',
		'python3 --version',
		'python --version',
		'javac -version',
		'npm --version',
		'docker --version',
		'g++ --version',
		'go version',
		'rustc --version',
		'dotnet --version',
		'ruby --version',
		'php --version',
		'perl --version',
		'swift --version',
		'kotlin -version',
		'tsc --version',
		'dart --version',
		'rg --version',
	].map(execCommand));

	const env = {};

	env.os = `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`;
	env.node = process.version;  // Node 版本可直接获取

	env.npm = npmResult.success ? npmResult.output : 'Not found';

	const simplePattern = /^[a-zA-Z]+\s+(?:version\s+)?("?)(\S+\1)/;
	const commonMatch = result => result.success ? result.output.match(simplePattern)?.[2] || result.output : "Not found";

	env.git = commonMatch(gitResult);

	if (bashResult.success) {
		const match = bashResult.output.match(/version\s+(\S+)/);
		env.bash = match ? match[1] : bashResult.output.split('\n')[0];
	} else {
		env.bash = 'Not found';
	}

	if (python3Result.success) env.python = commonMatch(python3Result);
	else if (pythonResult.success) env.python = commonMatch(pythonResult);
	else env.python = 'Not found';

	env.java = commonMatch(javaResult)

	if (cppResult.success) {
		const s = cppResult.output.replace(/\s[a-f0-9]{40}/, "");
		env['g++'] = s.match(simplePattern)?.[2] || s;
	} else {
		const clangResult = await execCommand('clang++ --version');
		env['clang'] = clangResult.success ? clangResult.output : 'Not found';
	}

	env.go = commonMatch(goResult);
	env.rust = commonMatch(rustResult);
	env.docker = commonMatch(dockerResult);
	env.ripgrep = commonMatch(ripgrepResult);

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