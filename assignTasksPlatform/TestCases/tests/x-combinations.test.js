'use strict';
// X1, X3–X7, X9–X13: feature combinations ("Feature combination test cases" in the doc).
// The restart combinations X2, X8 and X14 are in restart.test.js.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TestServer, withServer } = require('../lib/harness');
const db = require('../lib/db');
const f = require('../lib/flow');

describe('X: feature combinations', () => {
  let srv;
  let c2;
  before(async () => { srv = await new TestServer().start(); });
  after(async () => { if (srv) await srv.cleanup(); });
  beforeEach(async () => {
    await srv.reset();
    c2 = srv.C('C-02');
  });

  it('X1 Remove during the reroute pause: 409 STATE_CHANGED, the pause still sends one request', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.decline(f.aid(offered), c2), 'decline');
    f.assertError(await srv.api.removeContributor(id), 409, 'STATE_CHANGED', 'remove during pause');
    await f.sleepSim(8);
    const t = await f.getTask(srv, id);
    assert.equal(f.count(t.history, 'routing.requested(declined)'), 1);
    assert.equal(f.count(t.history, 'assignment.removed'), 0);
    assert.equal(t.history.filter((e) => e.type === 'routing.requested').length, 2);
  });

  it('X3 Reset during the reroute pause: the old pause never fires on the new task', async () => {
    const old = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, old, c2);
    f.ok(await srv.api.decline(f.aid(offered), c2), 'decline');
    await srv.reset();
    const id = await f.createTask(srv);
    assert.equal(id, old, 'new task reuses the id');
    await f.sleepSim(8);
    f.assertExact((await f.getTask(srv, id)).history, ['task.created', 'routing.requested(submit)']);
  });

  it('X4 an assignment id from before Reset is unknown afterwards: 404 NOT_FOUND', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    await srv.reset();
    f.assertError(await srv.api.accept(f.aid(offered), c2), 404, 'NOT_FOUND', 'accept old assignment');
  });

  it('X5 removed from an offer, then picked again: the old assignment stays dead', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }, { after_s: 2, outcome: c2 }] });
    const first = await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.removeContributor(id), 'remove');
    const second = await f.waitTask(srv, id, (t) => t.status === 'offered' && f.aid(t) !== f.aid(first), { message: 'second offer' });
    assert.equal(second.assignee.contributorId, c2);
    f.assertError(await srv.api.accept(f.aid(first), c2), 409, 'OFFER_NO_LONGER_AVAILABLE', 'accept old assignment');
    f.ok(await srv.api.accept(f.aid(second), c2), 'accept new assignment');
    assert.equal((await f.getTask(srv, id)).status, 'in_progress');
  });

  it('X6 race: C-02 completes T-001 as T-002\'s answer naming C-02 lands', async () => {
    const working = await f.startWork(srv, c2);
    const id = await f.createTask(srv, { answers: [{ after_s: 5, outcome: c2 }] });
    const sent = f.find((await f.waitEvent(srv, id, 'routing.requested(submit)')).history, 'routing.requested(submit)');
    await f.sleep(Math.max(0, Date.parse(sent.at) + f.simMs(5) - Date.now()));
    f.ok(await srv.api.complete(f.aid(working), c2), 'complete T-001');
    const t = await f.waitTask(srv, id, (x, h) => x.status === 'offered' || f.count(h, 'routing.requested(no_match)') > 0, { message: 'offer or reroute' });
    if (t.status === 'offered') assert.equal(t.assignee.contributorId, c2);
    else assert.equal(f.find(t.history, 'routing.pick_unavailable').details.busyOnTaskId, working.id);
    assert.ok(db.activeAssignmentsForContributor(srv.paths.dbFile, c2) <= 1, 'C-02 never on two tasks');
  });

  it('X7 overdue, offered, then declined: the new routing round starts clean', async () => {
    const id = await f.createTask(srv, { priority: 'high', answers: [{ after_s: 1, outcome: 'never' }, { after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.decline(f.aid(offered), c2), 'decline');
    const t = await f.waitEvent(srv, id, 'routing.requested(declined)');
    assert.equal(t.overdue, false);
    assert.ok(t.routingElapsedSeconds < 8, `routingElapsedSeconds restarts with the round, got ${t.routingElapsedSeconds}`);
  });

  it('X9 race: operator removes as the offer expires: exactly one outcome, one reroute', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    const expiresAt = Date.parse(f.find(offered.history, 'assignment.offered').at) + f.simMs(120);
    await f.sleep(Math.max(0, expiresAt - Date.now()));
    const rem = await srv.api.removeContributor(id);
    await f.waitTask(srv, id, (t, h) => h.filter((e) => e.type === 'routing.requested').length >= 2, { message: 'reroute' });
    await f.sleepSim(7);
    const t = await f.getTask(srv, id);
    if (rem.status < 300) {
      assert.deepEqual(f.labels(t.history).slice(4), ['assignment.removed', 'routing.requested(removed)']);
    } else {
      f.assertError(rem, 409, 'STATE_CHANGED', 'losing remove');
      assert.deepEqual(f.labels(t.history).slice(4), ['assignment.expired', 'action.rejected', 'routing.requested(expired)']);
    }
  });

  it('X10 the contributor sees every D24 field before accepting', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    await f.waitOffered(srv, id, c2);
    const work = await f.workOf(srv, c2);
    assert.equal(work.id, id);
    for (const key of ['title', 'keyword', 'priority', 'description', 'disclaimers', 'estimatedEffort']) {
      assert.equal(work[key], f.TASK_DEFAULTS[key], `work view shows ${key}`);
    }
  });

  it('X11 an expired offer counts like a decline for the D31 start-over', async () => {
    const fixture = { contributors: [
      { name: 'Ana Lima', keywords: ['finance'] },
      { name: 'Priya Shah', keywords: ['python'] },
      { name: 'Omar Haddad', keywords: ['python'] },
    ] };
    await withServer(fixture, async (s) => {
      const [p2, p3] = [s.C('C-02'), s.C('C-03')];
      const id = await f.createTask(s, { answers: [
        { after_s: 2, outcome: p2 }, { after_s: 2, outcome: p3 }, { after_s: 2, outcome: p2 },
      ] });
      await f.waitOffered(s, id, p2);
      const o2 = await f.waitOffered(s, id, p3, { timeoutSim: 150 });
      f.ok(await s.api.decline(f.aid(o2), p3), 'C-03 declines');
      const t = await f.waitTask(s, id, (x, h) => f.count(h, 'assignment.offered') === 3, { message: 'third offer' });
      const requests = t.history.filter((e) => e.type === 'routing.requested');
      assert.deepEqual(requests.map((e) => e.details.reason), ['submit', 'expired', 'declined']);
      assert.deepEqual(requests.map((e) => e.details.eligibleCount), [2, 1, 2]);
    });
  });

  it('X12 a contributor whose offer expired can be offered another task at once', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    await f.waitOffered(srv, id, c2);
    await f.waitEvent(srv, id, 'assignment.expired', 1, { timeoutSim: 150 });
    const next = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const t = await f.waitOffered(srv, next, c2);
    assert.equal(f.count(t.history, 'routing.pick_unavailable'), 0);
  });

  it('X13 Reroute now with a stale version on an offered task: NOT_ROUTING wins over the version check', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.assertError(await srv.api.rerouteNow(id, offered.version - 1), 409, 'NOT_ROUTING', 'stale version');
  });
});
