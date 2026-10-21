'use strict';
// Restart cases: T11, T12, U7, E4–E7, I17–I19, X2, X8, X14.
// The engine's scripts and timers live in memory, so they are gone after a
// restart. never_return_rate is 1.0 here so requests sent after a restart stay
// silent instead of answering at random.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TestServer, withServer } = require('../lib/harness');
const f = require('../lib/flow');

const SILENT_ENGINE = { settings: { engine: { never_return_rate: 1 } } };
// A hard kill loses up to one heartbeat (2 s), and boot time counts as downtime.
const HEARTBEAT_SLACK = 2;

function assertDowntime(event, nominal, measured) {
  const d = event.details.downtimeSeconds;
  assert.ok(d >= nominal - 1 && d <= measured + HEARTBEAT_SLACK + 1,
    `downtimeSeconds ${d} should be between ${nominal - 1} and ${(measured + HEARTBEAT_SLACK + 1).toFixed(1)}`);
}

describe('Restart cases', () => {
  let srv;
  let c2;
  before(async () => { srv = await new TestServer(SILENT_ENGINE).start(); });
  after(async () => { if (srv) await srv.cleanup(); });
  beforeEach(async () => {
    await srv.reset();
    c2 = srv.C('C-02');
  });

  it('T11 restart mid-routing: down 30 s, 10 s into a request', async () => {
    const id = await f.createTask(srv, { priority: 'high', answers: [{ after_s: 15, outcome: c2 }] });
    await f.waitEvent(srv, id, 'routing.requested(submit)');
    await f.sleepSim(10);
    const measured = await srv.restart(30);
    const t = await f.waitEvent(srv, id, 'routing.requested(restart)');
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'server.restarted',
      'routing.lost_on_restart', 'routing.requested(restart)',
    ]);
    assertDowntime(f.find(t.history, 'server.restarted'), 30, measured);
    assert.equal(f.find(t.history, 'routing.lost_on_restart').requestId, f.requestId(id, 1));
    assert.equal(t.status, 'routing');
    // The deadline counts from the restart request, not from the original submit.
    const o = await f.waitEvent(srv, id, 'routing.overdue');
    f.assertApprox(f.simGap(f.find(o.history, 'routing.requested(restart)'), f.find(o.history, 'routing.overdue')), 25, 2.5, 'deadline after restart');
  });

  it('T12 restart during an offer: offer 20 s old, down 60 s, 100 s still left', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    await f.waitOffered(srv, id, c2);
    await f.sleepSim(20);
    const before = (await f.getTask(srv, id)).assignee.offerExpiresInSeconds;
    f.assertApprox(before, 100, 3, 'offer countdown before restart');
    await srv.restart(60);
    const t = await f.getTask(srv, id);
    f.assertExact(t.history, ['task.created', 'routing.requested(submit)', 'routing.answered', 'assignment.offered', 'server.restarted']);
    assert.equal(t.status, 'offered');
    assert.equal(t.assignee.contributorId, c2);
    f.assertApprox(t.assignee.offerExpiresInSeconds, before, HEARTBEAT_SLACK + 3, 'offer paused through downtime');
  });

  it('U7 restart while a contributor is working: work clock pauses (scaled to 60 s of work)', async () => {
    const working = await f.startWork(srv, c2);
    await f.sleepSim(60);
    const before = (await f.getTask(srv, working.id)).assignee.workSeconds;
    f.assertApprox(before, 60, 3, 'work clock before restart');
    const measured = await srv.restart(60);
    const t = await f.getTask(srv, working.id);
    assert.equal(t.status, 'in_progress');
    assert.equal(t.assignee.contributorId, c2);
    f.assertTail(t.history, 4, ['assignment.accepted', 'server.restarted']);
    assertDowntime(f.find(t.history, 'server.restarted'), 60, measured);
    f.assertApprox(t.assignee.workSeconds, before, HEARTBEAT_SLACK + 3, 'work clock paused through downtime (D39)');
  });

  it('E4 restart during the 5 s reroute pause: request goes out 3 s after restart', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    f.ok(await srv.api.decline(f.aid(offered), c2), 'decline');
    await f.sleepSim(2);
    await srv.restart(30);
    const t = await f.waitEvent(srv, id, 'routing.requested(declined)');
    f.assertTail(t.history, 4, ['assignment.declined', 'server.restarted', 'routing.requested(declined)']);
    const gap = f.simGap(f.find(t.history, 'server.restarted'), f.find(t.history, 'routing.requested(declined)'));
    assert.ok(gap >= 1.5 && gap <= 3 + HEARTBEAT_SLACK + 1, `remaining pause after restart should be ~3 s, was ${gap.toFixed(1)} s`);
  });

  it('E5 restart while a request is overdue: lost, re-sent, overdue cleared', async () => {
    const id = await f.createTask(srv, { priority: 'high' });
    await f.waitEvent(srv, id, 'routing.requested(retry_deadline)');
    await f.sleepSim(5);
    assert.equal((await f.getTask(srv, id)).overdue, true, 'overdue before restart');
    await srv.restart(10);
    const t = await f.waitEvent(srv, id, 'routing.requested(restart)');
    f.assertExact(t.history, [
      'task.created', 'routing.requested(submit)', 'routing.overdue', 'routing.requested(retry_deadline)',
      'server.restarted', 'routing.lost_on_restart', 'routing.requested(restart)',
    ]);
    assert.equal(f.find(t.history, 'routing.lost_on_restart').requestId, f.requestId(id, 2));
    assert.equal(t.overdue, false, 'overdue cleared for the new request');
  });

  it('E6 two restarts in a row: offer clocks extended by 40 s in total', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    await f.waitOffered(srv, id, c2);
    const before = (await f.getTask(srv, id)).assignee.offerExpiresInSeconds;
    const m1 = await srv.restart(20);
    await f.sleepSim(2);
    const m2 = await srv.restart(20);
    const t = await f.getTask(srv, id);
    const restarts = f.findAll(t.history, 'server.restarted');
    assert.equal(restarts.length, 2);
    const total = restarts.reduce((s, e) => s + e.details.downtimeSeconds, 0);
    assert.ok(total >= 39 && total <= m1 + m2 + 2 * (HEARTBEAT_SLACK + 1), `total downtime ${total}`);
    // 2 s of uptime between the restarts is the only time the offer should lose.
    f.assertApprox(t.assignee.offerExpiresInSeconds, before - 2, 2 * HEARTBEAT_SLACK + 4, 'offer countdown');
  });

  it('E7 offer expiry lands during downtime: 10 s still left after restart, then expires', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    const offeredAt = Date.parse(f.find(offered.history, 'assignment.offered').at);
    await f.sleep(Math.max(0, offeredAt + f.simMs(110) - Date.now()));
    const before = (await f.getTask(srv, id)).assignee.offerExpiresInSeconds;
    await srv.restart(60);
    const after = await f.getTask(srv, id);
    assert.equal(after.status, 'offered', 'not expired by the downtime');
    f.assertApprox(after.assignee.offerExpiresInSeconds, before, HEARTBEAT_SLACK + 3, 'remaining offer time');
    const t = await f.waitEvent(srv, id, 'routing.requested(expired)', 1, { timeoutSim: 30 });
    f.assertTail(t.history, 3, ['assignment.offered', 'server.restarted', 'assignment.expired', 'routing.requested(expired)']);
    f.assertApprox(f.simGap(f.find(t.history, 'server.restarted'), f.find(t.history, 'assignment.expired')),
      after.assignee.offerExpiresInSeconds, 2.5, 'expiry after restart');
  });

  it('I17 first boot is not a restart', async () => {
    await withServer(SILENT_ENGINE, async (s) => {
      const id = await f.createTask(s);
      const t = await f.waitEvent(s, id, 'routing.requested(submit)');
      assert.equal(f.count(t.history, 'server.restarted'), 0);
      await s.restart(5);
      assert.equal(f.count((await f.getTask(s, id)).history, 'server.restarted'), 1, 'a real restart is logged');
    });
  });

  it('I18 completed tasks are left alone on restart', async () => {
    const working = await f.startWork(srv, c2);
    f.ok(await srv.api.complete(f.aid(working), c2), 'complete');
    const done = await f.waitStatus(srv, working.id, 'completed');
    const routingId = await f.createTask(srv);
    await f.waitEvent(srv, routingId, 'routing.requested(submit)');
    await srv.restart(5);
    assert.deepEqual((await f.getTask(srv, working.id)).history, done.history, 'completed history unchanged');
    assert.equal(f.count((await f.getTask(srv, routingId)).history, 'server.restarted'), 1);
  });

  it('X2 Accept right after a restart, with time still left on the offer', async () => {
    const id = await f.createTask(srv, { answers: [{ after_s: 2, outcome: c2 }] });
    const offered = await f.waitOffered(srv, id, c2);
    await f.sleepSim(100);
    await srv.restart(60);
    f.ok(await srv.api.accept(f.aid(offered), c2), 'accept after restart');
    const t = await f.waitStatus(srv, id, 'in_progress');
    assert.equal(f.count(t.history, 'assignment.expired'), 0);
  });

  it('X8 Complete after a restart: workSeconds in assignment.completed excludes the downtime', async () => {
    const working = await f.startWork(srv, c2);
    await f.sleepSim(20);
    await srv.restart(60);
    f.ok(await srv.api.complete(f.aid(working), c2), 'complete');
    const t = await f.waitStatus(srv, working.id, 'completed');
    f.assertApprox(f.find(t.history, 'assignment.completed').details.workSeconds, 20, HEARTBEAT_SLACK + 4, 'workSeconds');
  });

  it('X14 restart mid-routing: routingElapsedSeconds pauses through the downtime', async () => {
    const id = await f.createTask(srv, { priority: 'low' });
    await f.waitEvent(srv, id, 'routing.requested(submit)');
    await f.sleepSim(10);
    const before = (await f.getTask(srv, id)).routingElapsedSeconds;
    await srv.restart(30);
    const after = (await f.waitEvent(srv, id, 'routing.requested(restart)')).routingElapsedSeconds;
    f.assertApprox(after, before, HEARTBEAT_SLACK + 3, 'routingElapsedSeconds');
  });

  it('I19 clean shutdown writes a final heartbeat: downtime ≈ 30 s, not 30 + up to 2', {
    skip: process.platform === 'win32' && 'SIGINT cannot be sent to a child process on Windows; run by hand with Ctrl+C',
  }, async () => {
    const id = await f.createTask(srv);
    await f.waitEvent(srv, id, 'routing.requested(submit)');
    await f.sleepSim(3);
    await srv.stopGracefully();
    const stoppedAt = Date.now();
    await f.sleepSim(30);
    await srv.start();
    const measured = ((srv.readyAt - stoppedAt) * require('../lib/env').SPEED) / 1000;
    const d = f.find((await f.getTask(srv, id)).history, 'server.restarted').details.downtimeSeconds;
    assert.ok(d >= 29 && d <= measured + 0.5, `downtimeSeconds ${d}, measured ${measured.toFixed(1)}`);
  });
});
