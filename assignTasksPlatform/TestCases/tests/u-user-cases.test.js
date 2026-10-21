'use strict';
// U1–U12 from "Your edge cases" (U7 is in restart.test.js). UI-only parts are in MANUAL.md.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TestServer, withServer } = require('../lib/harness');
const db = require('../lib/db');
const f = require('../lib/flow');

describe('U: user edge cases', () => {
  let srv;
  let c1; let c2; let c3; let c4;
  before(async () => { srv = await new TestServer().start(); });
  after(async () => { if (srv) await srv.cleanup(); });
  beforeEach(async () => {
    await srv.reset();
    [c1, c2, c3, c4] = ['C-01', 'C-02', 'C-03', 'C-04'].map((c) => srv.C(c));
  });

  it('U1 contributor picked by the engine shows on the operator dashboard within one poll', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 8, outcome: c2 }] });
    const t = await f.waitEvent(srv, id, 'assignment.offered');
    const offeredAt = Date.parse(f.find(t.history, 'assignment.offered').at);
    f.assertExact(t.history, ['task.created', 'routing.requested(submit)', 'routing.answered', 'assignment.offered']);
    const state = f.ok(await srv.api.state(), 'GET /api/state').body;
    assert.ok(Date.now() - offeredAt < 1000, 'checked within one poll interval');
    const row = f.taskList(state).find((x) => x.id === id);
    assert.ok(row, 'task is on the dashboard');
    assert.equal(row.status, 'offered');
    assert.equal(row.assignee.contributorId, c2);
    assert.ok(row.assignee.offerExpiresInSeconds > 110 && row.assignee.offerExpiresInSeconds <= 120,
      `offer countdown starts from 120 s, got ${row.assignee.offerExpiresInSeconds}`);
  });

  it('U2 contributor never opens the offer: expires, C-02 free and excluded from the next pick', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 5, outcome: c2 }] });
    await f.waitOffered(srv, id, c2);
    const t = await f.waitEvent(srv, id, 'routing.requested(expired)', 1, { timeoutSim: 150 });
    f.assertTail(t.history, 3, ['assignment.offered', 'assignment.expired', 'routing.requested(expired)']);
    f.assertApprox(f.simGap(f.find(t.history, 'assignment.expired'), f.find(t.history, 'routing.requested(expired)')), 5, 1.5, 'reroute pause');
    assert.equal(t.status, 'routing');
    assert.equal(await f.workOf(srv, c2), null, 'C-02 free again');
    assert.equal(f.find(t.history, 'routing.requested(expired)').details.eligibleCount,
      f.find(t.history, 'routing.requested(submit)').details.eligibleCount - 1, 'C-02 excluded (D31)');
  });

  it('U3 accept vs offer expiry: exactly one outcome, never two assignees (accept/complete vs remove: see T9, T10)', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    const expiresAt = Date.parse(f.find(offered.history, 'assignment.offered').at) + f.simMs(120);
    await f.sleep(Math.max(0, expiresAt - Date.now()));
    const acc = await srv.api.accept(f.aid(offered), c2);
    if (acc.status < 300) {
      const t = await f.waitStatus(srv, id, 'in_progress');
      f.assertTail(t.history, 4, ['assignment.accepted']);
    } else {
      f.assertError(acc, 409, 'OFFER_NO_LONGER_AVAILABLE', 'late accept');
      const t = await f.waitEvent(srv, id, 'routing.requested(expired)');
      f.assertTail(t.history, 4, ['assignment.expired', 'action.rejected', 'routing.requested(expired)']);
    }
    assert.ok(db.activeAssignmentsForTask(srv.paths.dbFile, id) <= 1);
  });

  it('U4 answer at 70 s after a low-priority retry at 60 s is stale', async () => {
    const id = await f.createTask(srv, { priority: 'low', answers: [{ after_s: 70, outcome: c2 }] });
    const t = await f.waitEvent(srv, id, 'routing.stale_ignored', 1, { timeoutSim: 90 });
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.overdue',
      'routing.requested(retry_deadline)', 'routing.stale_ignored',
    ]);
    assert.equal(f.find(t.history, 'routing.overdue').details.deadlineSeconds, 60);
    assert.equal(f.find(t.history, 'routing.stale_ignored').requestId, f.requestId(id, 1));
    assert.equal(t.status, 'routing');
    assert.equal(t.currentRequestId, f.requestId(id, 2));
    assert.equal(await f.workOf(srv, c2), null, 'C-02 not offered by the stale answer');
  });

  it('U5 three tasks picked for one contributor at once: only the first holds C-02', async () => {
    const ids = [];
    for (const after_s of [8, 10, 12]) ids.push(await f.createTask(srv, { answers: [{ after_s, outcome: c2 }] }));
    await f.waitOffered(srv, ids[0], c2);
    for (const id of ids.slice(1)) {
      const t = await f.waitEvent(srv, id, 'routing.requested(no_match)');
      f.assertExact(t.history, [
        'task.created', 'routing.requested(submit)', 'routing.answered',
        'routing.pick_unavailable', 'routing.requested(no_match)',
      ]);
    }
    const holders = (await f.listTasks(srv)).filter((t) => t.assignee && t.assignee.contributorId === c2);
    assert.deepEqual(holders.map((t) => t.id), [ids[0]]);
    assert.equal(db.activeAssignmentsForContributor(srv.paths.dbFile, c2), 1, 'database never shows C-02 on two tasks');
  });

  it('U6 no match three times, then the only python contributor becomes free', async () => {
    const fixture = { contributors: [
      { name: 'Ana Lima', keywords: ['finance'] },
      { name: 'Lars Berg', keywords: ['finance'] },
      { name: 'Omar Haddad', keywords: ['python'] },
    ] };
    await withServer(fixture, async (s) => {
      const only = s.C('C-03');
      const first = await f.startWork(s, only);
      const noMatch = { after_s: 3, outcome: 'no_match' };
      const id = await f.createTask(s, { answers: [noMatch, noMatch, noMatch, { after_s: 3, outcome: only }] });
      await f.waitEvent(s, id, 'routing.no_match', 3, { timeoutSim: 60 });
      f.ok(await s.api.complete(f.aid(first), only), 'C-03 completes T-001');
      const t = await f.waitOffered(s, id, only);
      f.assertExact(t.history, [
        'task.created', 'routing.requested(submit)',
        'routing.no_match', 'routing.requested(no_match)',
        'routing.no_match', 'routing.requested(no_match)',
        'routing.no_match', 'routing.requested(no_match)',
        'routing.answered', 'assignment.offered',
      ]);
      const requests = t.history.filter((e) => e.type === 'routing.requested');
      assert.deepEqual(requests.map((e) => e.details.eligibleCount), [0, 0, 0, 1]);
      for (const nm of f.findAll(t.history, 'routing.no_match')) {
        const next = t.history[t.history.indexOf(nm) + 1];
        f.assertApprox(f.simGap(nm, next), 5, 1.5, 'pause after no match');
      }
    });
  });

  it('U8 operator revokes while the contributor is working', async () => {
    const working = await f.startWork(srv, c2);
    f.ok(await srv.api.removeContributor(working.id, working.version), 'remove');
    const t = await f.waitEvent(srv, working.id, 'routing.requested(removed)');
    f.assertTail(t.history, 4, ['assignment.accepted', 'assignment.removed', 'routing.requested(removed)']);
    assert.equal(f.find(t.history, 'assignment.removed').details.wasStatus, 'in_progress');
    f.assertApprox(f.simGap(f.find(t.history, 'assignment.removed'), f.find(t.history, 'routing.requested(removed)')), 5, 1.5, 'reroute pause');
    assert.equal(await f.workOf(srv, c2), null, 'C-02 free');
    f.assertError(await srv.api.complete(f.aid(working), c2), 409, 'REMOVED_FROM_ASSIGNMENT', 'complete after removal');
  });

  it('U9 Reroute now while routing is already running', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 15, outcome: c2 }] });
    await f.waitEvent(srv, id, 'routing.requested(submit)');
    await f.sleepSim(10);
    f.ok(await srv.api.rerouteNow(id), 'reroute now');
    const t = await f.waitEvent(srv, id, 'routing.stale_ignored');
    f.assertTail(t.history, 2, ['operator.reroute_now', 'routing.requested(operator_reroute)', 'routing.stale_ignored']);
    assert.equal(t.status, 'routing');
    assert.equal(t.currentRequestId, f.requestId(id, 2));
    assert.equal(t.requestCount, 2);
  });

  it('U10 multiple assignments in one task: decline, expire, then accept and complete', async () => {
    const id = await f.createTask(srv, { answers: [
      { after_s: 5, outcome: c1 }, { after_s: 5, outcome: c2 }, { after_s: 5, outcome: c4 },
    ] });
    const o1 = await f.waitOffered(srv, id, c1);
    f.ok(await srv.api.decline(f.aid(o1), c1), 'C-01 declines');
    await f.waitOffered(srv, id, c2);
    const o3 = await f.waitOffered(srv, id, c4, { timeoutSim: 150 });
    f.ok(await srv.api.accept(f.aid(o3), c4), 'C-04 accepts');
    f.ok(await srv.api.complete(f.aid(o3), c4), 'C-04 completes');
    const t = await f.waitStatus(srv, id, 'completed');
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.answered', 'assignment.offered',
      'assignment.declined', 'routing.requested(declined)', 'routing.answered', 'assignment.offered',
      'assignment.expired', 'routing.requested(expired)', 'routing.answered', 'assignment.offered',
      'assignment.accepted', 'assignment.completed',
    ]);
    const offers = f.findAll(t.history, 'assignment.offered');
    assert.equal(new Set(offers.map((e) => e.assignmentId)).size, 3, 'three assignment records');
    assert.deepEqual(offers.map((e) => e.details.contributorId), [c1, c2, c4]);
    assert.equal(f.find(t.history, 'assignment.completed').details.contributorId, c4);
    assert.equal(db.activeAssignmentsForTask(srv.paths.dbFile, id), 0);
  });

  it('U11 contributor cancels (= declines): history matches field by field and is append-only', async () => {
    const id = await f.createTask(srv, { keyword: 'python', priority: 'high', answers: [
      { after_s: 3, outcome: c2 }, { after_s: 3, outcome: c3 },
    ] });
    const offered = await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.decline(f.aid(offered), c2), 'decline');
    const snapshot = (await f.waitEvent(srv, id, 'assignment.declined')).history;
    const t = await f.waitOffered(srv, id, c3);
    const r1 = f.requestId(id, 1);
    const r2 = f.requestId(id, 2);
    const expected = [
      { type: 'task.created', actor: 'operator', details: { keyword: 'python', priority: 'high' } },
      { type: 'routing.requested', actor: 'system', requestId: r1, details: { reason: 'submit' } },
      { type: 'routing.answered', actor: 'engine', requestId: r1, details: { contributorId: c2 } },
      { type: 'assignment.offered', actor: 'system', details: { contributorId: c2, expiresInSeconds: 120 } },
      { type: 'assignment.declined', actor: 'contributor', details: { contributorId: c2 } },
      { type: 'routing.requested', actor: 'system', requestId: r2, details: { reason: 'declined' } },
      { type: 'routing.answered', actor: 'engine', requestId: r2, details: { contributorId: c3 } },
      { type: 'assignment.offered', actor: 'system', details: { contributorId: c3, expiresInSeconds: 120 } },
    ];
    assert.equal(t.history.length, expected.length);
    expected.forEach((exp, i) => {
      const e = t.history[i];
      assert.equal(e.taskId, id, `event ${i} taskId`);
      assert.equal(e.type, exp.type, `event ${i} type`);
      assert.equal(e.actor, exp.actor, `event ${i} (${exp.type}) actor`);
      if (exp.requestId) assert.equal(e.requestId, exp.requestId, `event ${i} (${exp.type}) requestId`);
      for (const [k, v] of Object.entries(exp.details)) assert.equal(e.details[k], v, `event ${i} (${exp.type}) details.${k}`);
      if (i) {
        assert.ok(e.id > t.history[i - 1].id, 'event ids increase');
        assert.ok(Date.parse(e.at) >= Date.parse(t.history[i - 1].at), 'oldest first');
      }
    });
    assert.deepEqual(t.history.slice(0, snapshot.length), snapshot, 'earlier events never edited or removed');
  });

  it('U12 one contributor with both keywords, two tasks with different keywords', async () => {
    await withServer({ contributors: [{ name: 'Ana Lima', keywords: ['finance', 'python'] }] }, async (s) => {
      const only = s.C('C-01');
      const noMatch = { after_s: 2, outcome: 'no_match' };
      const t1 = await f.createTask(s, { keyword: 'finance', answers: [{ after_s: 5, outcome: only }] });
      const t2 = await f.createTask(s, { keyword: 'python', answers: [{ after_s: 8, outcome: only }, noMatch, noMatch, { after_s: 2, outcome: only }] });
      const o1 = await f.waitOffered(s, t1, only);
      await f.waitEvent(s, t2, 'routing.no_match');
      f.ok(await s.api.decline(f.aid(o1), only), 'C-01 declines T-001 and becomes free');
      const t = await f.waitOffered(s, t2, only);
      f.assertExact(t.history, [
        'task.created', 'routing.requested(submit)', 'routing.answered', 'routing.pick_unavailable',
        'routing.requested(no_match)', 'routing.no_match', 'routing.requested(no_match)', 'routing.no_match',
        'routing.requested(no_match)', 'routing.answered', 'assignment.offered',
      ]);
      const requests = t.history.filter((e) => e.type === 'routing.requested');
      assert.equal(requests[0].details.eligibleCount, 1, 'C-01 free when T-002 was submitted');
      assert.equal(requests[1].details.eligibleCount, 0, 'C-01 busy on T-001');
      assert.equal(requests[3].details.eligibleCount, 1, 'C-01 free again');
      assert.equal(f.find(t.history, 'routing.pick_unavailable').details.busyOnTaskId, t1);
    });
  });
});
