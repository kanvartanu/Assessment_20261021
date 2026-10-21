'use strict';
// V1–V14: hostile or malformed input and request floods ("Hardening test cases" in the doc).
// Common rule: a bad request gets a 4xx JSON error, never a 500, and changes nothing.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TestServer } = require('../lib/harness');
const routes = require('../lib/routes');
const f = require('../lib/flow');

function assert4xx(res, what) {
  assert.ok(res.status >= 400 && res.status < 500, `${what}: expected 4xx, got ${res.status} ${res.text.slice(0, 200)}`);
}

describe('V: hardening', () => {
  let srv;
  let c2;
  before(async () => { srv = await new TestServer().start(); });
  after(async () => { if (srv) await srv.cleanup(); });
  beforeEach(async () => {
    await srv.reset();
    c2 = srv.C('C-02');
  });

  it('V1 SQL injection in path ids: 404 NOT_FOUND, data intact', async () => {
    const id = await f.createTask(srv);
    for (const bad of ["T-001' OR '1'='1", 'T-001; DROP TABLE tasks; --', '1 OR 1=1']) {
      f.assertError(await srv.api.getTask(encodeURIComponent(bad)), 404, 'NOT_FOUND', `GET ${bad}`);
    }
    f.assertError(await srv.api.work(encodeURIComponent("C-01' OR '1'='1")), 404, 'NOT_FOUND', 'work');
    f.assertError(await srv.api.accept(encodeURIComponent("A-001' OR '1'='1"), c2), 404, 'NOT_FOUND', 'accept');
    assert.equal((await f.listTasks(srv)).length, 1);
    assert.ok(await f.getTask(srv, id));
  });

  it('V2 HTML and script in text fields are stored and returned verbatim as JSON', async () => {
    const payload = '<script>alert(1)</script><img src=x onerror="alert(2)"> & \' " ✓';
    const id = await f.createTask(srv, { title: payload, description: payload, disclaimers: payload });
    const r = f.ok(await srv.api.getTask(id), 'GET');
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const t = f.taskOf(r.body);
    assert.equal(t.title, payload);
    assert.equal(t.description, payload);
    assert.equal(t.disclaimers, payload);
  });

  it('V3 wrong types on create: 400 VALIDATION_FAILED naming the field', async () => {
    const cases = [
      [{ keyword: ['python'] }, 'keyword'],
      [{ keyword: 'Python' }, 'keyword'],
      [{ priority: 1 }, 'priority'],
      [{ title: { text: 'x' } }, 'title'],
      [{ title: 42 }, 'title'],
      [{ title: '   ' }, 'title'],
    ];
    for (const [bad, field] of cases) {
      const body = f.assertError(await srv.api.createTask({ ...f.TASK_DEFAULTS, ...bad }), 400, 'VALIDATION_FAILED', JSON.stringify(bad));
      assert.ok(body.error.message.includes(field), `message "${body.error.message}" names ${field}`);
    }
    assert.equal((await f.listTasks(srv)).length, 0);
  });

  it('V4 wrong types for contributorId: 400, offer unchanged', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    const [method, url] = routes.accept(f.aid(offered));
    for (const bad of [[c2], { id: c2 }, 2, true]) {
      f.assertError(await srv.api.request(method, url, { contributorId: bad }), 400, 'VALIDATION_FAILED', JSON.stringify(bad));
    }
    const t = await f.getTask(srv, id);
    assert.equal(t.status, 'offered');
    assert.equal(f.count(t.history, 'assignment.accepted'), 0);
  });

  it('V5 malformed version on Reroute now: rejected with 4xx, nothing changes', async () => {
    const id = await f.createTask(srv);
    const t0 = await f.waitEvent(srv, id, 'routing.requested(submit)');
    for (const bad of ['abc', 1.5, -1, { v: 1 }, [t0.version]]) {
      assert4xx(await srv.api.rerouteNow(id, bad), `version ${JSON.stringify(bad)}`);
    }
    const t = await f.getTask(srv, id);
    assert.equal(t.currentRequestId, t0.currentRequestId);
    assert.equal(f.count(t.history, 'operator.reroute_now'), 0);
  });

  it('V6 __proto__ and constructor keys in a body do not pollute later requests', async () => {
    const raw = JSON.stringify(f.TASK_DEFAULTS).replace(/^\{/,
      '{"__proto__":{"polluted":"yes","priority":"high"},"constructor":{"prototype":{"polluted2":"yes"}},');
    const first = await srv.api.createTask(undefined, { raw });
    assert.ok(first.status < 300 || (first.status >= 400 && first.status < 500), `first create: ${first.status}`);
    const noPriority = { ...f.TASK_DEFAULTS };
    delete noPriority.priority;
    f.assertError(await srv.api.createTask(noPriority), 400, 'VALIDATION_FAILED', 'priority still required');
    for (const t of await f.listTasks(srv)) {
      assert.equal(t.polluted, undefined);
      assert.equal(t.polluted2, undefined);
    }
    assert.equal({}.polluted, undefined);
  });

  it('V7 oversized body (2 MB title): 4xx, server still healthy', async () => {
    assert4xx(await srv.api.createTask({ ...f.TASK_DEFAULTS, title: 'x'.repeat(2_000_000) }), '2 MB body');
    f.ok(await srv.api.state(), 'server alive');
    assert.equal((await f.listTasks(srv)).length, 0);
  });

  it('V8 server-owned fields in a create body are ignored (mass assignment)', async () => {
    const r = f.ok(await srv.api.createTask({
      ...f.TASK_DEFAULTS, id: 'T-999', status: 'completed', version: 99, overdue: true, requestCount: 42,
      createdAt: '2000-01-01T00:00:00.000Z', currentRequestId: 'R-999-9', assignee: { contributorId: c2 },
    }), 'create');
    const t = await f.getTask(srv, f.taskOf(r.body).id);
    assert.equal(t.id, 'T-001');
    assert.notEqual(t.status, 'completed');
    assert.ok(t.version < 99, `version ${t.version}`);
    assert.equal(t.requestCount, 1);
    assert.equal(t.currentRequestId, f.requestId('T-001', 1));
    assert.ok(Date.now() - Date.parse(t.createdAt) < 60_000, 'createdAt is server time');
    assert.equal(t.assignee, null);
    f.assertError(await srv.api.getTask('T-999'), 404, 'NOT_FOUND');
  });

  it('V9 non-JSON content type: 400, no task', async () => {
    assert4xx(await srv.api.createTask(undefined, { raw: JSON.stringify(f.TASK_DEFAULTS), contentType: 'text/plain' }), 'text/plain');
    assert.equal((await f.listTasks(srv)).length, 0);
  });

  it('V10 malformed engine script: 4xx, server still healthy', async () => {
    const [method, url] = routes.simScript();
    for (const body of [{ taskId: 'T-001', answers: 'never' }, { taskId: 'T-001', answers: [{ after_s: -5, outcome: 'drop' }] }, { answers: [] }]) {
      assert4xx(await srv.api.request(method, url, body), JSON.stringify(body));
    }
    f.ok(await srv.api.state(), 'server alive');
  });

  it('V11 50 concurrent Accepts on one offer: exactly one succeeds', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    const results = await Promise.all(Array.from({ length: 50 }, () => srv.api.accept(f.aid(offered), c2)));
    assert.equal(results.filter((r) => r.status < 300).length, 1);
    assert.ok(results.every((r) => r.status < 300 || r.status === 409), 'losers get 409');
    assert.equal(f.count((await f.getTask(srv, id)).history, 'assignment.accepted'), 1);
  });

  it('V12 30 concurrent creates: ids T-001..T-030, each submitted once', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => srv.api.createTask({ ...f.TASK_DEFAULTS, title: `Flood ${i}` })));
    results.forEach((r) => f.ok(r, 'create'));
    const ids = results.map((r) => f.taskOf(r.body).id).sort();
    assert.deepEqual(ids, Array.from({ length: 30 }, (_, i) => `T-${String(i + 1).padStart(3, '0')}`));
    for (const id of ids) {
      const t = await f.getTask(srv, id);
      assert.equal(f.count(t.history, 'task.created'), 1, id);
      assert.equal(f.count(t.history, 'routing.requested(submit)'), 1, id);
    }
  });

  it('V13 encoded path traversal: 404, no file contents', async () => {
    for (const bad of ['..%2F..%2Fpackage.json', '%2e%2e%2f%2e%2e%2fconfig%2fsettings.json', '..%5C..%5Cpackage.json']) {
      const r = await srv.api.request('GET', `/api/tasks/${bad}`);
      assert.equal(r.status, 404, `${bad}: ${r.status}`);
      assert.doesNotMatch(r.text, /"dependencies"|"speed_multiplier"/);
    }
  });

  it('V14 no hidden delete: DELETE /api/tasks/:id is refused and the task stays', async () => {
    const id = await f.createTask(srv);
    const r = await srv.api.request('DELETE', `/api/tasks/${id}`);
    assert.ok(r.status >= 400 && r.status < 500, `DELETE returned ${r.status}`);
    assert.ok(await f.getTask(srv, id));
  });
});
