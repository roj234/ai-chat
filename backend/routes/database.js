export function registerDatabaseRoutes(router) {
	router.delete('database', async (ctx) => {
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