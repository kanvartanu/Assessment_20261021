// Stored timestamps are real epoch milliseconds. Every configured duration is in
// simulated seconds and is divided by sim.speed_multiplier, so the whole system
// (engine delays, deadlines, offer expiry, pauses) speeds up together.
function createClock(speedMultiplier = 1) {
  return {
    now: () => Date.now(),
    // simulated seconds -> real milliseconds
    ms: (simSeconds) => (simSeconds * 1000) / speedMultiplier,
    // real milliseconds -> simulated seconds
    seconds: (realMs) => (realMs * speedMultiplier) / 1000,
  };
}

module.exports = { createClock };
