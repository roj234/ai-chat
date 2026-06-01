
BEGIN TRANSACTION;

CREATE TABLE blobs2 (
     hash BLOB PRIMARY KEY,
     type TEXT NOT NULL,
     name TEXT NOT NULL,
     indexedName TEXT UNIQUE NULL,
     size INTEGER NOT NULL,
     lastModified INTEGER NOT NULL
) WITHOUT ROWID;

INSERT INTO blobs2 (hash, type, name, size, lastModified)
SELECT hash, mime, name, size, time FROM blobs;

DROP TABLE blobs;
ALTER TABLE blobs2 RENAME TO blobs;

PRAGMA user_version = 1;

COMMIT;