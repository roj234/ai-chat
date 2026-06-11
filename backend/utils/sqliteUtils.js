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

export const tableMigration = (sql, oldColumns, newColumns) => {
	const table = sql.match(/CREATE TABLE ([a-zA-Z_]+)/i)[1];
	if (!table) throw new Error("Table name not specified");

	return `${sql.replaceAll(table, table+"1")}
    INSERT INTO ${table}1 (${newColumns || oldColumns}) SELECT ${oldColumns} FROM ${table};
DROP TABLE ${table};
ALTER TABLE ${table}1 RENAME TO ${table};
`;
}