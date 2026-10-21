'use strict';
// E1–E3, E8–E14, E16 from "Additional edge cases". E4–E7 are in restart.test.js,
// E15 in e15-engine-stats.test.js.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TestServer, withServer } = require('../lib/harness');
const f = require('../lib/flow');

const TWO_PYTHON = { contributors: [
  { name: 'Ana Lima', keywords: ['finance'] },
  { name: 'Priya Shah', keywords: ['python'] },
  { name: 'Omar Haddad', keywords: ['python'] },
] };

describe('E: additional edge cases', () => {
  let srv;
  let c2; let c3;
  before(async () => { srv = await new TestServer().start(); });
  after(async () => { if (srv) await srv.cleanup(); });
  beforeEach(async () => {
    await srv.reset();
    [c2, c3] = ['C-02', 'C-03'].map((c) => srv.C(c));
  });

  it('E1 everyone eligible declines: the third request starts over with both', async () => {
    await withServer(TWO_PYTHON, async (s) => {
      const [p2, p3] = [s.C('C-02'), s.C('C-03')];
      const id = await f.createTask(s, { answers: [
        { after_s: 3, outcome: p2 }, { after_s: 3, outcome: p3 }, { after_s: 3, outcome: p2 },
      ] });
      f.ok(await s.api.decline(f.aid(await f.waitOffered(s, id, p2)), p2), 'C-02 declines');
      f.ok(await s.api.decline(f.aid(await f.waitOffered(s, id, p3)), p3), 'C-03 declines');
      const t = await f.waitTask(s, id, (x, h) => f.count(h, 'assignment.offered') === 3, { message: 'third offer' });
      assert.equal(f.count(t.history, 'assignment.declined'), 2);
      const requests = t.history.filter((e) => e.type === 'routing.requested');
      assert.deepEqual(requests.map((e) => e.details.eligibleCount), [2, 1, 2]);
      assert.equal(t.assignee.contributorId, p2);
    });
  });

  it('E2 stale answer after the task is completed', async () => {
    const id = await f.createTask(srv, { priority: 'high', answers: [{ after_s: 40, outcome: c2 }, { after_s: 2, outcome: c3 }] });
    const offered = await f.waitOffered(srv, id, c3);
    f.ok(await srv.api.accept(f.aid(offered), c3), 'accept');
    f.ok(await srv.api.complete(f.aid(offered), c3), 'complete');
    const t = await f.waitEvent(srv, id, 'routing.stale_ignored', 1, { timeoutSim: 60 });
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.overdue', 'routing.requested(retry_deadline)',
      'routing.answered', 'assignment.offered', 'assignment.accepted', 'assignment.completed', 'routing.stale_ignored',
    ]);
    assert.equal(t.status, 'completed');
    assert.equal(await f.workOf(srv, c2), null, 'nobody gets an offer');
  });

  it('E3 stale answer names a busy contributor: only stale_ignored, C-02 untouched', async () => {
    const busy = await f.startWork(srv, c2);
    const id = await f.createTask(srv, { priority: 'high', answers: [{ after_s: 35, outcome: c2 }] });
    const t = await f.waitEvent(srv, id, 'routing.stale_ignored', 1, { timeoutSim: 50 });
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.overdue',
      'routing.requested(retry_deadline)', 'routing.stale_ignored',
    ]);
    const after = await f.getTask(srv, busy.id);
    assert.equal(after.status, 'in_progress');
    assert.equal(after.history.length, busy.history.length, 'nothing logged on C-02\'s task');
  });

  it('E8 wrong contributor accepts: 403 NOT_YOUR_OFFER, logged, offer unchanged', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.assertError(await srv.api.accept(f.aid(offered), c3), 403, 'NOT_YOUR_OFFER', 'C-03 accepts');
    const t = await f.getTask(srv, id);
    f.assertTail(t.history, 4, ['action.rejected']);
    assert.equal(f.find(t.history, 'action.rejected').details.code, 'NOT_YOUR_OFFER');
    assert.equal(t.status, 'offered');
    assert.equal(t.assignee.contributorId, c2);
  });

  it('E9 double click on Accept, then on Complete: one event each, second call 409 STATE_CHANGED', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    const a = await Promise.all([srv.api.accept(f.aid(offered), c2), srv.api.accept(f.aid(offered), c2)]);
    assert.equal(a.filter((r) => r.status < 300).length, 1, 'one accept wins');
    f.assertError(a.find((r) => r.status >= 300), 409, 'STATE_CHANGED', 'second accept');
    const c = await Promise.all([srv.api.complete(f.aid(offered), c2), srv.api.complete(f.aid(offered), c2)]);
    assert.equal(c.filter((r) => r.status < 300).length, 1, 'one complete wins');
    f.assertError(c.find((r) => r.status >= 300), 409, 'STATE_CHANGED', 'second complete');
    const t = await f.waitStatus(srv, id, 'completed');
    assert.equal(f.count(t.history, 'assignment.accepted'), 1);
    assert.equal(f.count(t.history, 'assignment.completed'), 1);
  });

  it('E10 Remove contributor on a completed task: 409 ALREADY_COMPLETED', async () => {
    const working = await f.startWork(srv, c2);
    f.ok(await srv.api.complete(f.aid(working), c2), 'complete');
    const done = await f.waitStatus(srv, working.id, 'completed');
    f.assertError(await srv.api.removeContributor(working.id), 409, 'ALREADY_COMPLETED', 'remove');
    const t = await f.getTask(srv, working.id);
    assert.deepEqual(f.labels(t.history), [...f.labels(done.history), 'action.rejected']);
    assert.equal(t.status, 'completed');
  });

  it('E11 two operator tabs click Reroute now: one wins, the other gets STATE_CHANGED', async () => {
    const id = await f.createTask(srv);
    const t0 = await f.waitEvent(srv, id, 'routing.requested(submit)');
    const r = await Promise.all([srv.api.rerouteNow(id, t0.version), srv.api.rerouteNow(id, t0.version)]);
    assert.equal(r.filter((x) => x.status < 300).length, 1, 'one reroute wins');
    const body = f.assertError(r.find((x) => x.status >= 300), 409, 'STATE_CHANGED', 'second tab');
    assert.ok(body.task && body.task.version > t0.version, 'loser gets the refreshed task');
    const t = await f.getTask(srv, id);
    assert.equal(f.count(t.history, 'operator.reroute_now'), 1);
    assert.equal(f.count(t.history, 'routing.requested(operator_reroute)'), 1);
  });

  it('E12 Reroute now on a task that is offered or in progress: 409 NOT_ROUTING', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.assertError(await srv.api.rerouteNow(id), 409, 'NOT_ROUTING', 'offered');
    f.ok(await srv.api.accept(f.aid(offered), c2), 'accept');
    await f.waitStatus(srv, id, 'in_progress');
    f.assertError(await srv.api.rerouteNow(id), 409, 'NOT_ROUTING', 'in progress');
  });

  it('E13 invalid task creation: 400 VALIDATION_FAILED naming the field, nothing created', async () => {
    const cases = [
      [{ keyword: 'healthcare' }, 'keyword must be one of: finance, python'],
      [{ title: '' }, 'title'],
      [{ priority: 'urgent' }, 'priority'],
    ];
    for (const [bad, text] of cases) {
      const body = f.assertError(await srv.api.createTask({ ...f.TASK_DEFAULTS, ...bad }), 400, 'VALIDATION_FAILED', JSON.stringify(bad));
      assert.ok(body.error.message.includes(text), `message "${body.error.message}" should mention "${text}"`);
    }
    assert.equal((await f.listTasks(srv)).length, 0, 'no task, no event');
  });

  it('E14 Reset while work is active: reloads seed data, late answers dropped without error', async () => {
    await f.startWork(srv, c2);
    await f.createTask(srv, { answers: [{ after_s: 10, outcome: c3 }] });
    await srv.reset();
    assert.equal((await f.listTasks(srv)).length, 0, 'seed tasks file is empty');
    assert.equal(await f.workOf(srv, c2), null, 'C-02 free after reset');
    await f.sleepSim(15);
    f.ok(await srv.api.state(), 'server still healthy after the old answer was due');
    assert.equal((await f.listTasks(srv)).length, 0, 'old answer created nothing');
    assert.equal(await f.workOf(srv, c3), null, 'old answer offered nothing');
  });

  it('E16 deadline per priority: overdue and retry at 25 s, 40 s and 60 s', async () => {
    const ids = {};
    for (const p of ['high', 'normal', 'low']) ids[p] = await f.createTask(srv, { priority: p });
    for (const [p, deadline] of [['high', 25], ['normal', 40], ['low', 60]]) {
      const t = await f.waitEvent(srv, ids[p], 'routing.requested(retry_deadline)', 1, { timeoutSim: 80 });
      const submit = f.find(t.history, 'routing.requested(submit)');
      const overdue = f.find(t.history, 'routing.overdue');
      f.assertApprox(f.simGap(submit, overdue), deadline, 2, `${p} overdue`);
      f.assertApprox(f.simGap(overdue, f.find(t.history, 'routing.requested(retry_deadline)')), 0, 1, `${p} retry immediately`);
      assert.equal(overdue.details.deadlineSeconds, deadline);
    }
  });
});
