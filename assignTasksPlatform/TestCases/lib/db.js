'use strict';
// Direct SQLite access for the tests that must bypass the API (T13, I16, N1, U5).
// Table names come from the doc: tasks, contributors, assignments, events.
const { DatabaseSync } = require('node:sqlite');

const ACTIVE = "status IN ('offered', 'accepted', 'in_progress')";

function withDb(file, fn) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all();
const tableNames = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

// The stored key for an API id: either the readable id itself or a numeric seq.
function rowKey(db, table, apiId) {
  if (db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).get(apiId)) return apiId;
  const n = Number(String(apiId).replace(/\D/g, ''));
  if (columns(db, table).some((c) => c.name === 'seq')) {
    const r = db.prepare(`SELECT id FROM ${table} WHERE seq = ?`).get(n);
    if (r) return r.id;
  }
  const r = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(n);
  if (r) return r.id;
  throw new Error(`${apiId} not found in ${table}`);
}

// Copies the task's active assignment row under a new id, optionally onto
// another task. Throws whatever SQLite throws (the unique index should).
function duplicateActiveAssignment(file, fromTaskId, { toTaskId } = {}) {
  return withDb(file, (db) => {
    const row = db.prepare(`SELECT * FROM assignments WHERE task_id = ? AND ${ACTIVE}`).get(rowKey(db, 'tasks', fromTaskId));
    if (!row) throw new Error(`no active assignment on ${fromTaskId}`);
    const copy = { ...row };
    if (toTaskId) copy.task_id = rowKey(db, 'tasks', toTaskId);
    for (const c of columns(db, 'assignments')) {
      if (!c.pk && c.name !== 'seq') continue;
      const v = row[c.name];
      copy[c.name] = typeof v === 'number' || typeof v === 'bigint'
        ? Number(db.prepare(`SELECT MAX(${c.name}) AS m FROM assignments`).get().m) + 1
        : `${v}-DUP`;
    }
    const names = Object.keys(copy);
    db.prepare(`INSERT INTO assignments (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...names.map((n) => copy[n]));
  });
}

function activeAssignmentsForContributor(file, contributorId) {
  return withDb(file, (db) => Number(db.prepare(
    `SELECT COUNT(*) AS n FROM assignments WHERE contributor_id = ? AND ${ACTIVE}`,
  ).get(rowKey(db, 'contributors', contributorId)).n));
}

function activeAssignmentsForTask(file, taskId) {
  return withDb(file, (db) => Number(db.prepare(
    `SELECT COUNT(*) AS n FROM assignments WHERE task_id = ? AND ${ACTIVE}`,
  ).get(rowKey(db, 'tasks', taskId)).n));
}

function exec(file, sql) {
  return withDb(file, (db) => db.exec(sql));
}

module.exports = {
  withDb, tableNames, duplicateActiveAssignment,
  activeAssignmentsForContributor, activeAssignmentsForTask, exec,
};
