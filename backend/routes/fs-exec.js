import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathFilter} from "./fs.js";

const execFilePromise = promisify(execFile);

export function registerFsExecRoutes(router) {
	router.post('spawn', async (ctx) => {
		const { program, arguments: args, directory, timeout = 10 } = await ctx.readBody();
		const safeCwd = pathFilter(ctx, directory);
		const result = await execFilePromise(program, args, {
			cwd: safeCwd,
			timeout: timeout * 1000
		}).catch(err => ({
			code: err.code,
			stdout: err.stdout,
			stderr: err.stderr
		}));
		ctx.send(200, result);
	});
}