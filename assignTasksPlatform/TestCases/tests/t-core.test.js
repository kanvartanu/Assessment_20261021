'use strict';
// T1–T10, T13, T14 from "Test cases". The restart cases T11 and T12 are in restart.test.js.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TestServer, withServer } = require('../lib/harness');
const db = require('../lib/db');
const f = require('../lib/flow');

describe('T: core test cases', () => {
  let srv;
  let c2; let c3;
  before(async () => { srv = await new TestServer().start(); });
  after(async () => { if (srv) await srv.cleanup(); });
  beforeEach(async () => {
    await srv.reset();
    [c2, c3] = ['C-02', 'C-03'].map((c) => srv.C(c));
  });

  it('T1 routine: answer C-02 after 8 s, accept, complete', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 8, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.accept(f.aid(offered), c2), 'accept');
    await f.waitStatus(srv, id, 'in_progress');
    f.ok(await srv.api.complete(f.aid(offered), c2), 'complete');
    const done = await f.waitStatus(srv, id, 'completed');

    f.assertExact(done.history, [
      'task.created', 'routing.requested(submit)', 'routing.answered',
      'assignment.offered', 'assignment.accepted', 'assignment.completed',
    ]);
    const answered = f.find(done.history, 'routing.answered');
    assert.equal(answered.details.contributorId, c2);
    f.assertApprox(answered.details.latencySeconds, 8, 1.5, 'latencySeconds');
    assert.equal(f.find(done.history, 'assignment.completed').details.contributorId, c2);
    if (done.assignee) assert.equal(done.assignee.contributorId, c2, 'completed task keeps C-02 as assignee');
  });

  it('T2 unresolved: request 1 never answers, request 2 answers C-02 after 6 s', async () => {
    const id = await f.createTask(srv, { priority: 'high', answers: [{ after_s: 1, outcome: 'never' }, { after_s: 6, outcome: c2 }] });
    const t = await f.waitOffered(srv, id, c2);
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.overdue',
      'routing.requested(retry_deadline)', 'routing.answered', 'assignment.offered',
    ]);
    assert.equal(t.overdue, false, 'overdue cleared by the offer');
    assert.equal(t.requestCount, 2);
    assert.equal(f.find(t.history, 'routing.overdue').details.deadlineSeconds, 25);
    f.assertApprox(f.simGap(f.find(t.history, 'routing.requested(submit)'), f.find(t.history, 'routing.overdue')), 25, 2, 'overdue after 25 s');
    assert.equal(f.find(t.history, 'routing.answered').requestId, f.requestId(id, 2));
  });

  it('T3 late answer after retry: R-1 answers at 30 s, R-2 (sent at 25 s) answers C-03 after 3 s', async () => {
    const id = await f.createTask(srv, { priority: 'high', answers: [{ after_s: 30, outcome: c2 }, { after_s: 3, outcome: c3 }] });
    const t = await f.waitEvent(srv, id, 'routing.stale_ignored');
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.overdue', 'routing.requested(retry_deadline)',
      'routing.answered', 'assignment.offered', 'routing.stale_ignored',
    ]);
    assert.equal(f.find(t.history, 'routing.answered').requestId, f.requestId(id, 2));
    const stale = f.find(t.history, 'routing.stale_ignored');
    assert.equal(stale.requestId, f.requestId(id, 1));
    // R-2 already led to the offer, so no request is pending (same rule as I1).
    assert.equal(stale.details.currentRequestId, null);
    assert.equal(t.status, 'offered');
    assert.equal(t.assignee.contributorId, c3, 'R-1 did not change the offer');
    assert.equal(await f.workOf(srv, c2), null, 'C-02 got nothing from the stale answer');
  });

  it('T4 intervention while pending: Reroute now at 10 s, R-1 answers at 15 s', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 15, outcome: c2 }] });
    await f.waitEvent(srv, id, 'routing.requested(submit)');
    await f.sleepSim(10);
    f.ok(await srv.api.rerouteNow(id), 'reroute now');
    const t = await f.waitEvent(srv, id, 'routing.stale_ignored');
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'operator.reroute_now',
      'routing.requested(operator_reroute)', 'routing.stale_ignored',
    ]);
    assert.equal(f.find(t.history, 'operator.reroute_now').details.requestId, f.requestId(id, 1));
    assert.equal(t.status, 'routing');
    assert.equal(t.currentRequestId, f.requestId(id, 2));
    assert.equal(t.assignee, null);
  });

  it('T5 recovery: C-02 declines, reroute after 5 s excludes C-02, C-03 is offered', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 5, outcome: c2 }, { after_s: 5, outcome: c3 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.decline(f.aid(offered), c2), 'decline');
    const t = await f.waitOffered(srv, id, c3);
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.answered', 'assignment.offered',
      'assignment.declined', 'routing.requested(declined)', 'routing.answered', 'assignment.offered',
    ]);
    const first = f.find(t.history, 'routing.requested(submit)');
    const second = f.find(t.history, 'routing.requested(declined)');
    f.assertApprox(f.simGap(f.find(t.history, 'assignment.declined'), second), 5, 1.5, 'reroute pause');
    assert.equal(second.details.eligibleCount, first.details.eligibleCount - 1, 'C-02 excluded');
  });

  it('T6 recovery: offer to C-02 expires after 120 s and the task reroutes', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 5, outcome: c2 }] });
    await f.waitOffered(srv, id, c2);
    const t = await f.waitEvent(srv, id, 'routing.requested(expired)', 1, { timeoutSim: 150 });
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.answered', 'assignment.offered',
      'assignment.expired', 'routing.requested(expired)',
    ]);
    f.assertApprox(f.simGap(f.find(t.history, 'assignment.offered'), f.find(t.history, 'assignment.expired')), 120, 2.5, 'offer expiry');
    assert.equal(t.status, 'routing');
  });

  it('T7 no match: no eligible contributor, rerouting repeats every 5 s', async () => {
    const noMatch = Array.from({ length: 4 }, () => ({ after_s: 5, outcome: 'no_match' }));
    await withServer({ contributors: [{ name: 'Lars Berg', keywords: ['finance'] }] }, async (s) => {
      const id = await f.createTask(s, { keyword: 'python', answers: noMatch });
      const t = await f.waitEvent(s, id, 'routing.no_match', 3, { timeoutSim: 60 });
      f.assertPrefix(t.history, [
        'task.created', 'routing.requested(submit)', 'routing.no_match', 'routing.requested(no_match)',
        'routing.no_match', 'routing.requested(no_match)', 'routing.no_match',
      ]);
      for (const r of f.findAll(t.history, 'routing.requested(submit)').concat(f.findAll(t.history, 'routing.requested(no_match)'))) {
        assert.equal(r.details.eligibleCount, 0);
      }
      f.assertApprox(f.simGap(f.find(t.history, 'routing.no_match'), f.find(t.history, 'routing.requested(no_match)')), 5, 1.5, 'reroute pause');
      assert.equal(t.status, 'routing');
    });
  });

  it('T8 remove mid-work: operator removes C-02 after accept', async () => {
    const working = await f.startWork(srv, c2);
    f.ok(await srv.api.removeContributor(working.id, working.version), 'remove');
    const t = await f.waitEvent(srv, working.id, 'routing.requested(removed)');
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.answered', 'assignment.offered',
      'assignment.accepted', 'assignment.removed', 'routing.requested(removed)',
    ]);
    assert.equal(f.find(t.history, 'assignment.removed').details.wasStatus, 'in_progress');
    assert.equal(t.status, 'routing');
    assert.equal(t.assignee, null);
  });

  it('T9 race: accept vs remove sent together (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      if (round) await srv.reset();
      const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
      const offered = await f.waitOffered(srv, id, c2);
      const [acc, rem] = await Promise.all([srv.api.accept(f.aid(offered), c2), srv.api.removeContributor(id)]);
      f.ok(rem, 'remove (no version: always applies)');
      const t = await f.waitEvent(srv, id, 'routing.requested(removed)');
      if (acc.status < 300) {
        f.assertTail(t.history, 4, ['assignment.accepted', 'assignment.removed', 'routing.requested(removed)']);
      } else {
        f.assertError(acc, 409, 'OFFER_NO_LONGER_AVAILABLE', 'losing accept');
        f.assertTail(t.history, 4, ['assignment.removed', 'action.rejected', 'routing.requested(removed)']);
      }
      assert.equal(t.status, 'routing');
      assert.equal(t.assignee, null);
      assert.equal(db.activeAssignmentsForTask(srv.paths.dbFile, id), 0, 'never two assignees');
    }
  });

  it('T10 race: complete vs remove sent together (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      if (round) await srv.reset();
      const working = await f.startWork(srv, c2);
      const [comp, rem] = await Promise.all([
        srv.api.complete(f.aid(working), c2), srv.api.removeContributor(working.id),
      ]);
      if (comp.status < 300) {
        f.assertError(rem, 409, 'ALREADY_COMPLETED', 'losing remove');
        const t = await f.waitStatus(srv, working.id, 'completed');
        f.assertTail(t.history, 5, ['assignment.completed', 'action.rejected']);
      } else {
        f.ok(rem, 'winning remove');
        f.assertError(comp, 409, 'REMOVED_FROM_ASSIGNMENT', 'losing complete');
        const t = await f.waitEvent(srv, working.id, 'routing.requested(removed)');
        f.assertTail(t.history, 5, ['assignment.removed', 'action.rejected', 'routing.requested(removed)']);
        assert.equal(t.status, 'routing');
      }
    }
  });

  it('T13 one-assignee invariant: a second active assignment is refused by the database', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const before = await f.waitOffered(srv, id, c2);
    assert.throws(() => db.duplicateActiveAssignment(srv.paths.dbFile, id), /UNIQUE/i);
    const t = await f.getTask(srv, id);
    assert.equal(t.status, 'offered');
    assert.equal(t.assignee.assignmentId, before.assignee.assignmentId);
    assert.equal(t.history.length, before.history.length, 'nothing logged');
    assert.equal(db.activeAssignmentsForTask(srv.paths.dbFile, id), 1);
  });

  it('T14 two tasks at once: both answer C-02, the second gets pick_unavailable', async () => {
    const t1 = await f.createTask(srv, { answers: [{ after_s: 8, outcome: c2 }] });
    const t2 = await f.createTask(srv, { answers: [{ after_s: 10, outcome: c2 }] });
    await f.waitOffered(srv, t1, c2);
    const t = await f.waitEvent(srv, t2, 'routing.requested(no_match)');
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.answered',
      'routing.pick_unavailable', 'routing.requested(no_match)',
    ]);
    const pick = f.find(t.history, 'routing.pick_unavailable');
    assert.equal(pick.details.contributorId, c2);
    assert.equal(pick.details.busyOnTaskId, t1);
    f.assertApprox(f.simGap(pick, f.find(t.history, 'routing.requested(no_match)')), 5, 1.5, 'reroute pause');
    assert.equal((await f.getTask(srv, t1)).assignee.contributorId, c2);
    assert.equal(t.status, 'routing');
  });
});
