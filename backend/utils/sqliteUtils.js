/**
 *
 * @param {import("node:sqlite").DatabaseSync} db
 */
export const cachePreparedSql = (db) => {
	const sqlCache = new Map;
	const originalPrepare = db.prepare;
	Object.defineProperty(db, "prepare", {
		value: (sql) => {
			let statement = sqlCache.get(sql);
			if (!statement) {
				if (sqlCache.size > 500) sqlCache.clear();

				statement = originalPrepare.call(db, sql);
				sqlCache.set(sql, statement);
			}
			return statement;
		}
	});
};