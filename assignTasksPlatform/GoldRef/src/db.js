const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Assignment statuses that hold the lock: an offer already counts (D17).
const SCHEMA = `
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  seq                 INTEGER NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  keyword             TEXT NOT NULL,
  priority            TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
  disclaimers         TEXT NOT NULL DEFAULT '',
  estimated_effort    TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL CHECK (status IN ('created', 'routing', 'offered', 'in_progress', 'completed')),
  created_at          INTEGER NOT NULL,
  current_request_id  TEXT,
  routing_started_at  INTEGER,
  routing_deadline_at INTEGER,
  next_routing_at     INTEGER,
  next_routing_reason TEXT,
  overdue             INTEGER NOT NULL DEFAULT 0,
  request_count       INTEGER NOT NULL DEFAULT 0,
  exclusion_floor     INTEGER NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE contributors (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  keywords              TEXT NOT NULL,
  current_assignment_id TEXT REFERENCES assignments(id)
);

CREATE TABLE assignments (
  id               TEXT PRIMARY KEY,
  seq              INTEGER NOT NULL UNIQUE,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  contributor_id   TEXT NOT NULL REFERENCES contributors(id),
  status           TEXT NOT NULL CHECK (status IN ('offered', 'accepted', 'completed', 'declined', 'expired', 'removed')),
  offered_at       INTEGER NOT NULL,
  offer_expires_at INTEGER NOT NULL,
  accepted_at      INTEGER,
  ended_at         INTEGER,
  paused_ms        INTEGER NOT NULL DEFAULT 0,
  reason           TEXT
);

CREATE UNIQUE INDEX one_active_assignment_per_task
  ON assignments(task_id) WHERE status IN ('offered', 'accepted');
CREATE UNIQUE INDEX one_active_assignment_per_contributor
  ON assignments(contributor_id) WHERE status IN ('offered', 'accepted');

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  assignment_id TEXT,
  request_id    TEXT,
  actor         TEXT NOT NULL CHECK (actor IN ('system', 'engine', 'operator', 'contributor')),
  type          TEXT NOT NULL,
  details       TEXT NOT NULL DEFAULT '{}',
  at            INTEGER NOT NULL
);
CREATE INDEX events_by_task ON events(task_id, id);

CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_alive_at INTEGER
);
INSERT INTO meta (id, last_alive_at) VALUES (1, NULL);
`;

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

function hasSchema(db) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get());
}

// Reset (D42): wipe everything, including the append-only log, and recreate.
function resetSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS events_append_only_update;
    DROP TRIGGER IF EXISTS events_append_only_delete;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS assignments;
    DROP TABLE IF EXISTS contributors;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS meta;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(SCHEMA);
}

// Re-entrant transaction. Callbacks registered with afterCommit run only once the
// outermost transaction commits, so side effects (engine requests) never escape a
// rolled-back write.
let depth = 0;
let commitHooks = [];

function transaction(db, fn) {
  if (depth > 0) return fn();
  depth += 1;
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    commitHooks = [];
    throw err;
  } finally {
    depth -= 1;
  }
  const hooks = commitHooks;
  commitHooks = [];
  for (const hook of hooks) hook();
  return result;
}

function afterCommit(hook) {
  if (depth > 0) commitHooks.push(hook);
  else hook();
}

module.exports = { openDb, hasSchema, resetSchema, transaction, afterCommit };
