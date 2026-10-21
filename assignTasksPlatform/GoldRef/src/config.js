const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
  } catch (err) {
    throw new Error(`${path.basename(file)}: ${err.message}`);
  }
}

const settings = readJson(process.env.SETTINGS_FILE || 'config/settings.json');
if (process.env.PORT) settings.server.port = Number(process.env.PORT);
if (process.env.DB_FILE) settings.db.path = process.env.DB_FILE;

// Seed files are re-read on every Reset so edits take effect without a restart.
const dataDir = process.env.DATA_DIR || 'data';

function loadData() {
  return {
    areas: readJson(path.join(dataDir, 'expertise-areas.json')),
    contributors: readJson(path.join(dataDir, 'contributors.json')),
    tasks: readJson(path.join(dataDir, 'tasks.json')),
    scenarios: readJson(path.join(dataDir, 'scenarios.json')),
  };
}

module.exports = { root, settings, loadData };
