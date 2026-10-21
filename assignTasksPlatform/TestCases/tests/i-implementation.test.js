'use strict';
// I1–I16 and I20–I23 from "Additional test cases from implementation".
// I17–I19 are in restart.test.js; I24 is a UI check in MANUAL.md.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TestServer, withServer, sleep } = require('../lib/harness');
const { writeJson, DEFAULT_CONTRIBUTORS } = require('../lib/fixtures');
const { SPEED } = require('../lib/env');
const db = require('../lib/db');
const f = require('../lib/flow');

describe('I: implementation cases', () => {
  let srv;
  let c2; let c3;
  before(async () => { srv = await new TestServer().start(); });
  after(async () => { if (srv) await srv.cleanup(); });
  beforeEach(async () => {
    await srv.reset();
    [c2, c3] = ['C-02', 'C-03'].map((c) => srv.C(c));
  });

  it('I1 stale answer lands during the 5 s reroute pause', async () => {
    await f.startWork(srv, c2);
    // R-2 starts at ~25 s and picks busy C-02 at ~26 s; the pause runs to ~31 s; R-1 answers at 29 s.
    const id = await f.createTask(srv, { priority: 'high', answers: [{ after_s: 29, outcome: c3 }, { after_s: 1, outcome: c2 }] });
    const t = await f.waitEvent(srv, id, 'routing.requested(no_match)', 1, { timeoutSim: 50 });
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.overdue', 'routing.requested(retry_deadline)',
      'routing.answered', 'routing.pick_unavailable', 'routing.stale_ignored', 'routing.requested(no_match)',
    ]);
    const stale = f.find(t.history, 'routing.stale_ignored');
    assert.equal(stale.requestId, f.requestId(id, 1));
    assert.equal(stale.details.currentRequestId, null);
    f.assertApprox(f.simGap(f.find(t.history, 'routing.pick_unavailable'), f.find(t.history, 'routing.requested(no_match)')), 5, 1.5, 'pause unaffected');
  });

  it('I2 Reroute now during the 5 s pause sends one request at once', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.decline(f.aid(offered), c2), 'decline');
    f.ok(await srv.api.rerouteNow(id), 'reroute now during the pause');
    await f.sleepSim(8);
    const t = await f.getTask(srv, id);
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.answered', 'assignment.offered',
      'assignment.declined', 'operator.reroute_now', 'routing.requested(operator_reroute)',
    ]);
    assert.equal(f.find(t.history, 'operator.reroute_now').details.requestId, null);
    f.assertApprox(f.simGap(f.find(t.history, 'operator.reroute_now'), f.find(t.history, 'routing.requested(operator_reroute)')), 0, 1, 'request at once');
  });

  it('I3 retry also overdue: two overdue events at 25 s and 50 s', async () => {
    const id = await f.createTask(srv, { priority: 'high' });
    const t = await f.waitEvent(srv, id, 'routing.overdue', 2, { timeoutSim: 70 });
    f.assertPrefix(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.overdue', 'routing.requested(retry_deadline)', 'routing.overdue',
    ]);
    const submit = f.find(t.history, 'routing.requested(submit)');
    f.assertApprox(f.simGap(submit, f.find(t.history, 'routing.overdue', 1)), 25, 2, 'first overdue');
    f.assertApprox(f.simGap(submit, f.find(t.history, 'routing.overdue', 2)), 50, 3, 'second overdue');
    const after = await f.waitEvent(srv, id, 'routing.requested(retry_deadline)', 2);
    assert.equal(after.overdue, true);
    assert.ok(after.routingElapsedSeconds >= 49, `routingElapsedSeconds counts from R-1: ${after.routingElapsedSeconds}`);
  });

  it('I4 Remove contributor on a routing task: 409 STATE_CHANGED, logged, unchanged', async () => {
    const id = await f.createTask(srv);
    const before = await f.waitEvent(srv, id, 'routing.requested(submit)');
    f.assertError(await srv.api.removeContributor(id), 409, 'STATE_CHANGED', 'remove');
    const t = await f.getTask(srv, id);
    assert.deepEqual(f.labels(t.history), [...f.labels(before.history), 'action.rejected']);
    assert.equal(t.status, 'routing');
    assert.equal(t.currentRequestId, before.currentRequestId);
  });

  it('I5 Remove with a stale version after accept, then with the fresh one', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.accept(f.aid(offered), c2), 'accept');
    const body = f.assertError(await srv.api.removeContributor(id, offered.version), 409, 'STATE_CHANGED', 'stale remove');
    assert.equal(body.task.status, 'in_progress', 'fresh task returned');
    assert.ok(body.task.version > offered.version);
    f.ok(await srv.api.removeContributor(id, body.task.version), 'remove with fresh version');
    const t = await f.waitEvent(srv, id, 'assignment.removed');
    assert.equal(f.find(t.history, 'assignment.removed').details.wasStatus, 'in_progress');
  });

  it('I6 Remove an offer: wasStatus offered, C-02 free and not excluded', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.removeContributor(id), 'remove');
    const t = await f.waitEvent(srv, id, 'routing.requested(removed)');
    assert.equal(f.find(t.history, 'assignment.removed').details.wasStatus, 'offered');
    assert.equal(await f.workOf(srv, c2), null);
    assert.equal(f.find(t.history, 'routing.requested(removed)').details.eligibleCount,
      f.find(t.history, 'routing.requested(submit)').details.eligibleCount, 'removed contributor not excluded');
  });

  it('I7 Complete before Accept: 409 STATE_CHANGED, offer unchanged', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.assertError(await srv.api.complete(f.aid(offered), c2), 409, 'STATE_CHANGED', 'complete');
    const t = await f.getTask(srv, id);
    assert.equal(t.status, 'offered');
    assert.equal(t.assignee.assignmentId, offered.assignee.assignmentId);
  });

  it('I8 Decline after expiry: 409 OFFER_NO_LONGER_AVAILABLE, no second reroute', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    await f.waitEvent(srv, id, 'assignment.expired', 1, { timeoutSim: 150 });
    f.assertError(await srv.api.decline(f.aid(offered), c2), 409, 'OFFER_NO_LONGER_AVAILABLE', 'late decline');
    await f.sleepSim(7);
    const t = await f.getTask(srv, id);
    assert.equal(f.count(t.history, 'routing.requested(expired)'), 1);
    assert.equal(f.count(t.history, 'routing.requested(declined)'), 0);
  });

  it('I9 Accept a few ms after offer_expires_at, before the ticker fires: never accepted', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    const expiresAt = Date.parse(f.find(offered.history, 'assignment.offered').at) + f.simMs(120);
    await sleep(Math.max(0, expiresAt + 15 - Date.now()));
    f.assertError(await srv.api.accept(f.aid(offered), c2), 409, 'OFFER_NO_LONGER_AVAILABLE', 'late accept');
    const t = await f.getTask(srv, id);
    assert.deepEqual(f.labels(t.history).slice(4, 6), ['assignment.expired', 'action.rejected'], 'catch-up expiry runs first');
    assert.equal(f.count(t.history, 'assignment.accepted'), 0);
  });

  it('I10 D31 start-over with a busy contributor: no start-over until C-03 is free', async () => {
    const fixture = { contributors: [
      { name: 'Ana Lima', keywords: ['finance'] },
      { name: 'Lars Berg', keywords: ['finance'] },
      { name: 'Omar Haddad', keywords: ['python'] },
      { name: 'Mei Chen', keywords: ['finance'] },
      { name: 'Priya Shah', keywords: ['python'] },
    ] };
    await withServer(fixture, async (s) => {
      const [p3, p5] = [s.C('C-03'), s.C('C-05')];
      const busy = await f.startWork(s, p3);
      const noMatch = { after_s: 2, outcome: 'no_match' };
      const id = await f.createTask(s, { answers: [{ after_s: 2, outcome: p5 }, noMatch, noMatch, noMatch] });
      f.ok(await s.api.decline(f.aid(await f.waitOffered(s, id, p5)), p5), 'C-05 declines');
      await f.waitEvent(s, id, 'routing.no_match', 2);
      const mid = (await f.getTask(s, id)).history.filter((e) => e.type === 'routing.requested');
      assert.deepEqual(mid.slice(1, 3).map((e) => e.details.eligibleCount), [0, 0], 'nobody eligible, no start-over');
      f.ok(await s.api.complete(f.aid(busy), p3), 'C-03 completes and is free');
      const t = await f.waitEvent(s, id, 'routing.no_match', 3);
      const third = t.history.filter((e) => e.type === 'routing.requested')[3];
      assert.ok(third, 'a request after C-03 is free');
      assert.equal(third.details.eligibleCount, 1, 'C-03 eligible, C-05 still excluded');
    });
  });

  it('I11 D31 start-over: third request has both again, later declines excluded again', async () => {
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
      f.ok(await s.api.decline(f.aid(await f.waitOffered(s, id, p2)), p2), 'C-02 declines');
      f.ok(await s.api.decline(f.aid(await f.waitOffered(s, id, p3)), p3), 'C-03 declines');
      const third = await f.waitTask(s, id, (x, h) => f.count(h, 'assignment.offered') === 3, { message: 'third offer' });
      f.ok(await s.api.decline(f.aid(third), p2), 'C-02 declines again');
      const t = await f.waitEvent(s, id, 'routing.requested(declined)', 3);
      const requests = t.history.filter((e) => e.type === 'routing.requested');
      assert.deepEqual(requests.map((e) => e.details.eligibleCount), [2, 1, 2, 1]);
    });
  });

  it('I12 Accept with an empty body: 400 contributorId is required', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    const [method, url] = require('../lib/routes').accept(f.aid(offered));
    const body = f.assertError(await srv.api.request(method, url, {}), 400, 'VALIDATION_FAILED', 'empty accept');
    assert.match(body.error.message, /contributorId is required/);
    assert.equal((await f.getTask(srv, id)).history.length, offered.history.length, 'no event');
  });

  it('I13 malformed JSON: 400 request body must be valid JSON', async () => {
    const body = f.assertError(await srv.api.createTask(undefined, { raw: '{"title": ' }), 400, 'VALIDATION_FAILED', 'bad JSON');
    assert.match(body.error.message, /request body must be valid JSON/);
    assert.equal((await f.listTasks(srv)).length, 0);
  });

  it('I14 unknown ids: 404 NOT_FOUND, no events', async () => {
    f.assertError(await srv.api.getTask('T-999'), 404, 'NOT_FOUND', 'GET T-999');
    f.assertError(await srv.api.accept('A-999', c2), 404, 'NOT_FOUND', 'accept A-999');
    f.assertError(await srv.api.work('C-99'), 404, 'NOT_FOUND', 'work C-99');
    assert.equal((await f.listTasks(srv)).length, 0);
  });

  it('I15 validation order: title, keyword, priority', async () => {
    const both = f.assertError(await srv.api.createTask({ ...f.TASK_DEFAULTS, title: '', keyword: 'healthcare' }), 400, 'VALIDATION_FAILED');
    assert.match(both.error.message, /title/);
    assert.doesNotMatch(both.error.message, /keyword/);
    const kp = f.assertError(await srv.api.createTask({ ...f.TASK_DEFAULTS, keyword: 'healthcare', priority: 'urgent' }), 400, 'VALIDATION_FAILED');
    assert.match(kp.error.message, /keyword/);
    assert.doesNotMatch(kp.error.message, /priority/);
  });

  it('I16 event log is append-only in SQLite; Reset still works', async () => {
    const id = await f.createTask(srv);
    await f.waitEvent(srv, id, 'routing.requested(submit)');
    assert.throws(() => db.exec(srv.paths.dbFile, "UPDATE events SET type = 'x'"), /append-only/);
    assert.throws(() => db.exec(srv.paths.dbFile, 'DELETE FROM events'), /append-only/);
    await srv.reset();
    assert.equal((await f.listTasks(srv)).length, 0);
  });

  it('I20 a contributor sees only their own work', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    await f.waitOffered(srv, id, c2);
    const other = f.ok(await srv.api.work(c3), 'work of C-03');
    assert.equal(other.body.task, null);
    assert.ok(!other.text.includes(id), 'nothing about C-02\'s offer');
    assert.equal((await f.workOf(srv, c2)).id, id);
  });

  it('I21 the speed multiplier is applied everywhere', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 8, outcome: c2 }] });
    const t = await f.waitOffered(srv, id, c2);
    const sent = f.find(t.history, 'routing.requested(submit)');
    const answered = f.find(t.history, 'routing.answered');
    f.assertApprox(Date.parse(answered.at) - Date.parse(sent.at), 8000 / SPEED, 150, 'real wait (ms)');
    f.assertApprox(answered.details.latencySeconds, 8, 0.5, 'latencySeconds');
    const a = t.assignee.offerExpiresInSeconds;
    await sleep(1000);
    const b = (await f.getTask(srv, id)).assignee.offerExpiresInSeconds;
    f.assertApprox(a - b, SPEED, Math.max(2, SPEED * 0.2), 'offer countdown per real second');
  });

  it('I22 bad seed file: Reset refused with nothing wiped; bad first boot exits and seeds later', async () => {
    const contributorsFile = path.join(srv.paths.dataDir, 'contributors.json');
    const id = await f.createTask(srv);
    try {
      writeJson(contributorsFile, [{ name: 'Bad Seed', keywords: ['healthcare'] }]);
      const bad = f.assertError(await srv.api.reset(), 400, 'VALIDATION_FAILED', 'reset with bad keyword');
      assert.match(bad.error.message, /Seed data invalid: contributors\.json entry 1/);
      assert.match(bad.error.message, /unknown keyword "healthcare"/);
      assert.ok(await f.getTask(srv, id), 'existing data untouched');
      writeJson(contributorsFile, '[{ "name": ');
      const broken = f.assertError(await srv.api.reset(), 400, 'VALIDATION_FAILED', 'reset with broken JSON');
      assert.match(broken.error.message, /contributors\.json/);
    } finally {
      writeJson(contributorsFile, DEFAULT_CONTRIBUTORS);
    }

    const fresh = new TestServer({ contributors: [{ name: 'Bad Seed', keywords: ['healthcare'] }] });
    try {
      const exit = await fresh.start({ expectExit: true });
      assert.notEqual(exit.code, 0, 'boot fails');
      assert.match(fresh.log, /healthcare/);
      const tables = fs.existsSync(fresh.paths.dbFile) ? db.withDb(fresh.paths.dbFile, db.tableNames) : [];
      assert.deepEqual(tables.filter((n) => !n.startsWith('sqlite_')), [], 'no tables created');
      writeJson(path.join(fresh.paths.dataDir, 'contributors.json'), DEFAULT_CONTRIBUTORS);
      await fresh.start();
      assert.equal(Object.keys(fresh.ids).length, DEFAULT_CONTRIBUTORS.length, 'seeds normally once fixed');
    } finally {
      await fresh.cleanup();
    }
  });

  it('I23 engine answer due after Reset does not touch the new task that reuses the id', async () => {
    const old = await f.createTask(srv, { answers: [{ after_s: 10, outcome: c2 }] });
    await f.waitEvent(srv, old, 'routing.requested(submit)');
    await srv.reset();
    const id = await f.createTask(srv);
    assert.equal(id, old, 'the new task reuses the id');
    await f.sleepSim(15);
    f.assertExact((await f.getTask(srv, id)).history, ['task.created', 'routing.requested(submit)']);
    assert.equal(await f.workOf(srv, c2), null);
  });
});
