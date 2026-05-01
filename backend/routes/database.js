import {ALLOW_DROP_DATABASE} from "../config.js";

export function registerDatabaseRoutes(router) {
	router.delete('database', async (ctx) => {
		if (!ALLOW_DROP_DATABASE) {
			ctx.send(403, { message: "管理员禁止了此操作"});
			return;
		}

		ctx.db.exec(`
      DELETE FROM messages;
      DELETE FROM conversations;
      DELETE FROM kv;
      DELETE FROM kvs;
      DELETE FROM statistics;
    `);
		ctx.send(200, { success: true });
	});
}