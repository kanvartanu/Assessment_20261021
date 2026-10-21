'use strict';
// Helpers the test files share: scripted task creation, polling, and history checks.
const assert = require('node:assert/strict');
const { SPEED } = require('./env');
const { sleep, simMs } = require('./harness');

const sleepSim = (s) => sleep(simMs(s));

// Appended to every script so that, once the scripted answers run out, the
// engine stays silent instead of falling back to random answers.
const NEVER_PAD = Array.from({ length: 10 }, () => ({ after_s: 1, outcome: 'never' }));

const TASK_DEFAULTS = {
  title: 'Clean the claims dataset',
  description: 'Deduplicate rows and fix date formats.',
  keyword: 'python',
  priority: 'high',
  disclaimers: 'Contains anonymised patient data.',
  estimatedEffort: '2 hours',
};

// API bodies may be the task itself or { task }.
function taskOf(body) {
  if (!body) return body;
  if (body.task && body.id === undefined) return body.task;
  return body;
}

function taskList(body) {
  if (Array.isArray(body)) return body;
  return (body && body.tasks) || [];
}

function ok(res, what = 'request') {
  assert.ok(res.status >= 200 && res.status < 300, `${what} failed: HTTP ${res.status} ${res.text}`);
  return res;
}

function assertError(res, status, code, what = 'request') {
  assert.equal(res.status, status, `${what}: expected HTTP ${status} ${code}, got ${res.status} ${res.text}`);
  assert.equal(res.body && res.body.error && res.body.error.code, code, `${what}: error code`);
  return res.body;
}

function assertApprox(actual, expected, tol, what) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= tol,
    `${what}: expected ${expected} ± ${tol}, got ${actual}`);
}

// ---- history -------------------------------------------------------------

const label = (e) => (e.type === 'routing.requested' ? `${e.type}(${e.details && e.details.reason})` : e.type);
const labels = (history) => history.map(label);
const count = (history, l) => labels(history).filter((x) => x === l).length;
const find = (history, l, n = 1) => history.filter((e) => label(e) === l)[n - 1];
const findAll = (history, l) => history.filter((e) => label(e) === l);

// Simulated seconds between two events, from their stored timestamps.
const simGap = (a, b) => ((Date.parse(b.at) - Date.parse(a.at)) * SPEED) / 1000;

function assertExact(history, expected, what = 'history') {
  assert.deepEqual(labels(history), expected, what);
}

function assertPrefix(history, expected, what = 'history') {
  assert.deepEqual(labels(history).slice(0, expected.length), expected, what);
}

// The events after the first `skip` events, compared exactly.
function assertTail(history, skip, expected, what = 'history') {
  assert.deepEqual(labels(history).slice(skip), expected, what);
}

// Expected request id for the n-th routing request of a task (D36: R-003-2).
const requestId = (taskId, n) => `R-${taskId.replace(/^T-/, '')}-${n}`;

// ---- tasks -----------------------------------------------------------------

async function getTask(srv, id) {
  const r = await srv.api.getTask(id);
  ok(r, `GET task ${id}`);
  return taskOf(r.body);
}

async function listTasks(srv) {
  const r = await srv.api.listTasks();
  ok(r, 'GET /api/tasks');
  return taskList(r.body);
}

// Task ids are predictable (T-001, T-002, ... in creation order).
async function nextTaskId(srv) {
  const max = (await listTasks(srv)).reduce((m, t) => Math.max(m, Number(String(t.id).replace(/\D/g, '')) || 0), 0);
  return `T-${String(max + 1).padStart(3, '0')}`;
}

// Scripts the engine for the next task id, then creates the task (which submits it, D32).
async function createTask(srv, { answers = [], ...fields } = {}) {
  const id = await nextTaskId(srv);
  ok(await srv.api.script(id, [...answers, ...NEVER_PAD]), `script ${id}`);
  const r = ok(await srv.api.createTask({ ...TASK_DEFAULTS, ...fields }), 'create task');
  assert.equal(taskOf(r.body).id, id, 'task ids are assigned in creation order');
  return id;
}

async function waitFor(fn, { timeoutMs, message, describe }) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last && last.done) return last.value;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${message}${describe && last ? `\n  last seen: ${describe(last.value)}` : ''}`);
}

// Polls the task detail until pred(task, history) is true. timeoutSim is in simulated seconds.
function waitTask(srv, id, pred, { timeoutSim = 40, message = 'condition' } = {}) {
  return waitFor(async () => {
    const t = await getTask(srv, id);
    return { done: pred(t, t.history || []), value: t };
  }, {
    timeoutMs: simMs(timeoutSim) + 3000,
    message: `${id}: ${message}`,
    describe: (t) => `status=${t && t.status} history=${t && JSON.stringify(labels(t.history || []))}`,
  });
}

function waitEvent(srv, id, l, n = 1, opts = {}) {
  return waitTask(srv, id, (t, h) => count(h, l) >= n, { message: `${n}× ${l}`, ...opts });
}

function waitOffered(srv, id, contributorId, opts = {}) {
  return waitTask(srv, id, (t) => t.status === 'offered' && t.assignee && t.assignee.contributorId === contributorId,
    { message: `offered to ${contributorId}`, ...opts });
}

function waitStatus(srv, id, status, opts = {}) {
  return waitTask(srv, id, (t) => t.status === status, { message: `status ${status}`, ...opts });
}

const aid = (task) => task.assignee && task.assignee.assignmentId;

// Offers the task to contributorId and has them accept it. Returns the in-progress task.
async function startWork(srv, contributorId, fields = {}) {
  const id = await createTask(srv, { answers: [{ after_s: 2, outcome: contributorId }], ...fields });
  const t = await waitOffered(srv, id, contributorId);
  ok(await srv.api.accept(aid(t), contributorId), 'accept');
  return waitStatus(srv, id, 'in_progress');
}

// The contributor's own view (C5). null task = free.
async function workOf(srv, contributorId) {
  const r = ok(await srv.api.work(contributorId), `work of ${contributorId}`);
  return r.body ? r.body.task : undefined;
}

module.exports = {
  sleep, sleepSim, simMs, NEVER_PAD, TASK_DEFAULTS,
  taskOf, taskList, ok, assertError, assertApprox,
  label, labels, count, find, findAll, simGap, assertExact, assertPrefix, assertTail, requestId,
  getTask, listTasks, nextTaskId, createTask, waitFor, waitTask, waitEvent, waitOffered, waitStatus,
  aid, startWork, workOf,
};
