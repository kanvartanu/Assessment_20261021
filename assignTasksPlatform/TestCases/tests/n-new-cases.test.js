'use strict';
// N1–N13: cases missing from the T/U/E/I tables, added to the doc under
// "Test cases added with the test suite".
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TestServer } = require('../lib/harness');
const db = require('../lib/db');
const f = require('../lib/flow');

const MESSAGES = {
  OFFER_NO_LONGER_AVAILABLE: 'This offer is no longer available.',
  ALREADY_COMPLETED: 'This task is already completed.',
  REMOVED_FROM_ASSIGNMENT: 'You were removed from this assignment; your submission wasn\'t recorded.',
  STATE_CHANGED: 'This task changed while you were looking at it. The view has been refreshed.',
  NOT_FOUND: 'Task not found.',
  NOT_ROUTING: 'This task isn\'t routing right now. Use Remove contributor instead.',
  NOT_YOUR_OFFER: 'This offer belongs to another contributor.',
};

describe('N: cases added with the test suite', () => {
  let srv;
  let c2; let c3;
  before(async () => { srv = await new TestServer().start(); });
  after(async () => { if (srv) await srv.cleanup(); });
  beforeEach(async () => {
    await srv.reset();
    [c2, c3] = ['C-02', 'C-03'].map((c) => srv.C(c));
  });

  it('N1 one-task-per-contributor index: a second active assignment for C-02 is refused (D35)', async () => {
    const offered = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    await f.waitOffered(srv, offered, c2);
    const other = await f.createTask(srv);
    await f.waitEvent(srv, other, 'routing.requested(submit)');
    assert.throws(() => db.duplicateActiveAssignment(srv.paths.dbFile, offered, { toTaskId: other }), /UNIQUE/i);
    assert.equal(db.activeAssignmentsForContributor(srv.paths.dbFile, c2), 1);
    assert.equal((await f.getTask(srv, other)).assignee, null);
  });

  it('N2 wrong contributor declines: 403 NOT_YOUR_OFFER, offer unchanged', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.assertError(await srv.api.decline(f.aid(offered), c3), 403, 'NOT_YOUR_OFFER', 'C-03 declines');
    const t = await f.getTask(srv, id);
    assert.equal(t.status, 'offered');
    assert.equal(t.assignee.contributorId, c2);
    assert.deepEqual(f.findAll(t.history, 'action.rejected').map((e) => e.details.code), ['NOT_YOUR_OFFER']);
  });

  it('N13 wrong contributor completes: 403 NOT_YOUR_OFFER, work unchanged', async () => {
    const working = await f.startWork(srv, c2);
    f.assertError(await srv.api.complete(f.aid(working), c3), 403, 'NOT_YOUR_OFFER', 'C-03 completes');
    const t = await f.getTask(srv, working.id);
    assert.equal(t.status, 'in_progress');
    assert.equal(t.assignee.contributorId, c2);
    assert.deepEqual(f.findAll(t.history, 'action.rejected').map((e) => e.details.code), ['NOT_YOUR_OFFER']);
  });

  it('N3 Reroute now on a completed task: 409 NOT_ROUTING', async () => {
    const working = await f.startWork(srv, c2);
    f.ok(await srv.api.complete(f.aid(working), c2), 'complete');
    await f.waitStatus(srv, working.id, 'completed');
    f.assertError(await srv.api.rerouteNow(working.id), 409, 'NOT_ROUTING', 'reroute completed task');
    const t = await f.getTask(srv, working.id);
    assert.equal(t.status, 'completed');
    assert.equal(f.count(t.history, 'operator.reroute_now'), 0);
  });

  it('N4 two operator tabs click Remove: one removal, one reroute, the other tab gets STATE_CHANGED', async () => {
    const working = await f.startWork(srv, c2);
    const r = await Promise.all([
      srv.api.removeContributor(working.id, working.version), srv.api.removeContributor(working.id, working.version),
    ]);
    assert.equal(r.filter((x) => x.status < 300).length, 1, 'one removal wins');
    f.assertError(r.find((x) => x.status >= 300), 409, 'STATE_CHANGED', 'second tab');
    await f.waitEvent(srv, working.id, 'routing.requested(removed)');
    await f.sleepSim(7);
    const t = await f.getTask(srv, working.id);
    assert.equal(f.count(t.history, 'assignment.removed'), 1);
    assert.equal(f.count(t.history, 'routing.requested(removed)'), 1);
  });

  it('N5 Reroute now on an overdue task clears the Overdue flag', async () => {
    const id = await f.createTask(srv, { priority: 'high' });
    const overdue = await f.waitEvent(srv, id, 'routing.requested(retry_deadline)');
    assert.equal(overdue.overdue, true);
    f.ok(await srv.api.rerouteNow(id, overdue.version), 'reroute now');
    const t = await f.waitEvent(srv, id, 'routing.requested(operator_reroute)');
    assert.equal(t.overdue, false);
    assert.equal(f.find(t.history, 'operator.reroute_now').details.requestId, f.requestId(id, 2));
    assert.equal(t.currentRequestId, f.requestId(id, 3));
  });

  it('N6 task JSON matches the output format through its whole life', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 5, outcome: c2 }] });
    const created = await f.getTask(srv, id);
    for (const key of ['id', 'title', 'description', 'keyword', 'priority', 'disclaimers', 'estimatedEffort', 'status',
      'createdAt', 'ageSeconds', 'overdue', 'currentRequestId', 'requestCount', 'routingElapsedSeconds', 'assignee', 'version', 'history']) {
      assert.ok(key in created, `task has ${key}`);
    }
    assert.match(id, /^T-\d{3}$/);
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'UTC ISO timestamp');
    assert.equal(created.estimatedEffort, f.TASK_DEFAULTS.estimatedEffort);
    assert.equal(created.disclaimers, f.TASK_DEFAULTS.disclaimers);
    assert.equal(created.currentRequestId, f.requestId(id, 1));
    assert.equal(created.requestCount, 1);
    await f.sleepSim(3);
    f.assertApprox((await f.getTask(srv, id)).ageSeconds - created.ageSeconds, 3, 1.5, 'ageSeconds grows');

    const offered = await f.waitOffered(srv, id, c2);
    const a = offered.assignee;
    assert.match(a.assignmentId, /^A-\d{3}$/);
    assert.equal(a.name, 'Priya Shah');
    assert.equal(a.status, 'offered');
    assert.equal(typeof a.offerExpiresInSeconds, 'number');
    assert.equal(a.workSeconds, null);
    f.ok(await srv.api.accept(a.assignmentId, c2), 'accept');
    await f.sleepSim(3);
    const working = await f.getTask(srv, id);
    assert.equal(working.status, 'in_progress');
    f.assertApprox(working.assignee.workSeconds, 3, 1.5, 'workSeconds counts');
    assert.ok(working.version > offered.version, 'version increases on each change');

    f.ok(await srv.api.complete(a.assignmentId, c2), 'complete');
    await f.waitStatus(srv, id, 'completed');
    const listed = (await f.listTasks(srv)).find((t) => t.id === id);
    assert.ok(listed && listed.status === 'completed', 'completed task stays on the dashboard (D16, D25)');
    const detail = await f.getTask(srv, id);
    for (const e of detail.history) {
      for (const key of ['id', 'taskId', 'at', 'actor', 'type', 'requestId', 'assignmentId', 'details']) assert.ok(key in e, `${e.type} has ${key}`);
      assert.ok(['system', 'engine', 'operator', 'contributor'].includes(e.actor), `${e.type} actor ${e.actor}`);
    }
  });

  it('N7 every rejected action returns { error: { code, message }, task } with the UI text', async () => {
    const check = (res, status, code, id) => {
      const body = f.assertError(res, status, code);
      assert.equal(body.error.message, MESSAGES[code], `${code} message`);
      if (id) assert.equal(body.task && body.task.id, id, `${code} returns the current task`);
    };
    check(await srv.api.getTask('T-999'), 404, 'NOT_FOUND');

    const a = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, a, c2);
    check(await srv.api.rerouteNow(a), 409, 'NOT_ROUTING', a);
    check(await srv.api.accept(f.aid(offered), c3), 403, 'NOT_YOUR_OFFER', a);
    check(await srv.api.complete(f.aid(offered), c2), 409, 'STATE_CHANGED', a);
    f.ok(await srv.api.accept(f.aid(offered), c2), 'accept');
    f.ok(await srv.api.removeContributor(a), 'remove');
    check(await srv.api.complete(f.aid(offered), c2), 409, 'REMOVED_FROM_ASSIGNMENT', a);

    const b = await f.startWork(srv, c3);
    f.ok(await srv.api.complete(f.aid(b), c3), 'complete');
    await f.waitStatus(srv, b.id, 'completed');
    check(await srv.api.removeContributor(b.id), 409, 'ALREADY_COMPLETED', b.id);

    const c = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const o = await f.waitOffered(srv, c, c2);
    f.ok(await srv.api.removeContributor(c), 'remove offer');
    check(await srv.api.accept(f.aid(o), c2), 409, 'OFFER_NO_LONGER_AVAILABLE', c);
  });

  it('N8 completing frees the contributor for the next task at once', async () => {
    const first = await f.startWork(srv, c2);
    f.ok(await srv.api.complete(f.aid(first), c2), 'complete');
    await f.waitStatus(srv, first.id, 'completed');
    assert.equal(await f.workOf(srv, c2), null, 'C-02 free');
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const t = await f.waitOffered(srv, id, c2);
    assert.equal(f.count(t.history, 'routing.pick_unavailable'), 0);
  });

  it('N9 busy contributors are not counted as eligible (D35)', async () => {
    const first = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const t1 = await f.waitOffered(srv, first, c2);
    const id = await f.createTask(srv);
    const t2 = await f.waitEvent(srv, id, 'routing.requested(submit)');
    assert.equal(f.find(t2.history, 'routing.requested(submit)').details.eligibleCount,
      f.find(t1.history, 'routing.requested(submit)').details.eligibleCount - 1);
  });

  it('N10 decline vs offer expiry: exactly one outcome and one reroute', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    const expiresAt = Date.parse(f.find(offered.history, 'assignment.offered').at) + f.simMs(120);
    await f.sleep(Math.max(0, expiresAt - Date.now()));
    const dec = await srv.api.decline(f.aid(offered), c2);
    await f.waitTask(srv, id, (t, h) => h.some((e) => e.type === 'routing.requested' && e.details.reason !== 'submit'), { message: 'reroute' });
    await f.sleepSim(7);
    const t = await f.getTask(srv, id);
    if (dec.status < 300) {
      assert.deepEqual(f.labels(t.history).slice(4), ['assignment.declined', 'routing.requested(declined)']);
    } else {
      f.assertError(dec, 409, 'OFFER_NO_LONGER_AVAILABLE', 'losing decline');
      assert.deepEqual(f.labels(t.history).slice(4), ['assignment.expired', 'action.rejected', 'routing.requested(expired)']);
    }
  });

  it('N11 missing required fields: 400 VALIDATION_FAILED naming the field', async () => {
    for (const field of ['title', 'keyword', 'priority']) {
      const fields = { ...f.TASK_DEFAULTS };
      delete fields[field];
      const body = f.assertError(await srv.api.createTask(fields), 400, 'VALIDATION_FAILED', `missing ${field}`);
      assert.ok(body.error.message.includes(field), `message "${body.error.message}" names ${field}`);
    }
    assert.equal((await f.listTasks(srv)).length, 0);
  });

  it('N12 a stale no-match answer is ignored and does not start a reroute', async () => {
    const id = await f.createTask(srv, { priority: 'high', answers: [{ after_s: 35, outcome: 'no_match' }, { after_s: 2, outcome: c2 }] });
    const t = await f.waitEvent(srv, id, 'routing.stale_ignored', 1, { timeoutSim: 50 });
    await f.sleepSim(7);
    const after = await f.getTask(srv, id);
    f.assertExact(after.history, [
      'task.created', 'routing.requested(submit)', 'routing.overdue', 'routing.requested(retry_deadline)',
      'routing.answered', 'assignment.offered', 'routing.stale_ignored',
    ]);
    assert.equal(after.status, 'offered');
    assert.equal(after.assignee.contributorId, c2);
    assert.equal(f.find(t.history, 'routing.stale_ignored').requestId, f.requestId(id, 1));
  });
});
