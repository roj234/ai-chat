
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS logs2 (
    id INTEGER UNIQUE,
    time INTEGER NOT NULL,
    data BLOB NOT NULL
);
INSERT INTO logs2 (id, time, data) SELECT id, time, data FROM logs;
DROP TABLE logs;
ALTER TABLE logs2 RENAME TO logs;

PRAGMA user_version = 1;

COMMIT;