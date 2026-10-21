'use strict';
// E15 engine statistics: unscripted requests, speed ×100.
// 20% ± 3% never answer; every answer arrives 5–20 s (simulated) after its request.
// E15_REQUESTS overrides the sample size (default 1,000).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withServer, sleep } = require('../lib/harness');
const f = require('../lib/flow');

const SPEED = 100;
const N = Number(process.env.E15_REQUESTS || 1000);
// Low priority: 60 s deadline, so no retry happens inside the 5–20 s window.
const ANSWER_TYPES = new Set(['routing.answered', 'routing.no_match', 'routing.stale_ignored']);

describe('E15 engine statistics', () => {
  it(`E15 ${N} random requests: 20% ± 3% never answer, answers in 5–20 s`, { timeout: 10 * 60 * 1000 }, async () => {
    await withServer({ settings: { sim: { speed_multiplier: SPEED } } }, async (s) => {
      const ids = [];
      for (let i = 0; i < N; i++) {
        const r = f.ok(await s.api.createTask({ ...f.TASK_DEFAULTS, priority: 'low', title: `E15 #${i + 1}` }), 'create');
        ids.push(f.taskOf(r.body).id);
      }
      // 25 simulated seconds after the last submit, every R-1 has answered or never will.
      await sleep((25 * 1000) / SPEED);
      let answered = 0;
      const latencies = [];
      for (const id of ids) {
        const t = await f.getTask(s, id);
        const r1 = f.requestId(id, 1);
        const answer = t.history.find((e) => e.requestId === r1 && ANSWER_TYPES.has(e.type));
        if (!answer) continue;
        answered++;
        const sent = t.history.find((e) => e.requestId === r1 && e.type === 'routing.requested');
        latencies.push(answer.details && typeof answer.details.latencySeconds === 'number'
          ? answer.details.latencySeconds
          : ((Date.parse(answer.at) - Date.parse(sent.at)) * SPEED) / 1000);
      }
      const neverRate = 1 - answered / N;
      assert.ok(Math.abs(neverRate - 0.2) <= 0.03, `never-answer rate ${(neverRate * 100).toFixed(1)}%`);
      // 0.5 s of slack for timer jitter (5 ms real at ×100).
      const out = latencies.filter((l) => l < 4.5 || l > 20.5);
      assert.equal(out.length, 0, `latencies outside 5–20 s: ${out.slice(0, 10).join(', ')}`);
    });
  });
});
