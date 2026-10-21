// Simulated routing engine. It receives a task and the eligible contributors, and
// after 5-20 s either picks one at random or reports no match. 20% of requests
// never answer at all. Pending timers live in memory only, so a restart loses them.
//
// Scripts make runs deterministic: a queue of answers per task, consumed one per
// request. Each answer is { after_s, outcome } where outcome is "never",
// "no_match", "random" or a contributor id. Once a task's script runs out the
// engine falls back to random behaviour.
function createEngine({ settings, clock, onAnswer }) {
  const { min_delay_s: minDelay, max_delay_s: maxDelay, never_return_rate: neverRate } = settings.engine;
  const scripts = new Map();
  const timers = new Set();

  function pickRandom(ids) {
    return ids.length ? ids[Math.floor(Math.random() * ids.length)] : null;
  }

  function plan(taskId, eligibleIds) {
    const queue = scripts.get(taskId);
    const scripted = queue && queue.shift();
    if (scripted) {
      if (scripted.outcome === 'never') return null;
      const delay = scripted.after_s ?? minDelay;
      if (scripted.outcome === 'no_match') return { delay, contributorId: null };
      if (scripted.outcome === 'random') return { delay, contributorId: pickRandom(eligibleIds) };
      return { delay, contributorId: scripted.outcome };
    }
    if (Math.random() < neverRate) return null;
    return { delay: minDelay + Math.random() * (maxDelay - minDelay), contributorId: pickRandom(eligibleIds) };
  }

  function request({ generation, taskId, requestId, eligibleIds }) {
    const answer = plan(taskId, eligibleIds);
    if (!answer) return; // unresolved: no result, no error, ever
    const timer = setTimeout(() => {
      timers.delete(timer);
      onAnswer({ generation, taskId, requestId, contributorId: answer.contributorId, latencySeconds: answer.delay });
    }, clock.ms(answer.delay));
    timers.add(timer);
  }

  function script(taskId, answers) {
    scripts.set(taskId, [...answers]);
  }

  function reset() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    scripts.clear();
  }

  return { request, script, reset };
}

module.exports = { createEngine };
