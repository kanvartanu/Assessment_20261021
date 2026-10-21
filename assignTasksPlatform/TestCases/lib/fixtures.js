'use strict';
// Seed and settings files for one test server, written to a temp folder and
// passed to the app through DATA_DIR and SETTINGS_FILE.
const fs = require('node:fs');
const path = require('node:path');
const { SPEED } = require('./env');

// Contributor ids follow file order (C-01, C-02, ...), so tests can use the
// doc's ids. Python holders: C-01..C-04 (4 eligible). Finance: C-01, C-05.
const DEFAULT_CONTRIBUTORS = [
  { name: 'Ana Lima', keywords: ['finance', 'python'] },
  { name: 'Priya Shah', keywords: ['python'] },
  { name: 'Omar Haddad', keywords: ['python'] },
  { name: 'Mei Chen', keywords: ['python'] },
  { name: 'Lars Berg', keywords: ['finance'] },
];

// Values from the doc's "Parameters planned for config/settings.json" table.
// server.port and db.path are placeholders; PORT and DB_FILE override them.
function baseSettings() {
  return {
    server: { port: 3000 },
    db: { path: 'var/app.db' },
    engine: { min_delay_s: 5, max_delay_s: 20, never_return_rate: 0.2 },
    routing: { deadline_s: { high: 25, normal: 40, low: 60 }, reroute_delay_s: 5 },
    offer: { expiry_s: 120 },
    heartbeat: { interval_s: 2 },
    ui: { poll_interval_ms: 1000 },
    sim: { speed_multiplier: SPEED, tick_ms: 100 },
  };
}

function deepMerge(target, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) target[k] = deepMerge(target[k] || {}, v);
    else target[k] = v;
  }
  return target;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function writeFixtures(dir, {
  contributors = DEFAULT_CONTRIBUTORS,
  tasks = [],
  scenarios = [],
  areas = ['finance', 'python'],
  settings = {},
} = {}) {
  const dataDir = path.join(dir, 'data');
  const settingsFile = path.join(dir, 'config', 'settings.json');
  const dbFile = path.join(dir, 'var', 'app.db');
  writeJson(path.join(dataDir, 'expertise-areas.json'), areas);
  writeJson(path.join(dataDir, 'contributors.json'), contributors);
  writeJson(path.join(dataDir, 'tasks.json'), tasks);
  writeJson(path.join(dataDir, 'scenarios.json'), scenarios);
  writeJson(settingsFile, deepMerge(baseSettings(), settings));
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  return { dataDir, settingsFile, dbFile, contributors };
}

module.exports = { DEFAULT_CONTRIBUTORS, writeFixtures, writeJson };
