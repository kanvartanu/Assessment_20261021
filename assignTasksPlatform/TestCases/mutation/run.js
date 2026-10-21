'use strict';
// Runs the suite against one app folder (a mutant copy or the unmutated app)
// and records which test ids fail in results/<id>.json.
//   node mutation/run.js --id baseline --app ../GoldRef
//   node mutation/run.js --id M07 --app C:/mutants/M07 [--pattern "E16|U4"]
// Make each mutant as a copy of the app with exactly one change from mutations.json.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const id = arg('id');
const app = arg('app');
const pattern = arg('pattern');
if (!id || !app) {
  console.error('usage: node mutation/run.js --id <M01|baseline> --app <app folder> [--pattern <regex>]');
  process.exit(2);
}

const root = path.join(__dirname, '..');
const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
const xml = path.join(resultsDir, `${id}.xml`);

const args = ['--test', '--test-concurrency=1', '--test-reporter=junit', `--test-reporter-destination=${xml}`];
if (pattern) args.push(`--test-name-pattern=${pattern}`);
args.push('tests/*.test.js');
spawnSync(process.execPath, args, {
  cwd: root, stdio: 'inherit', env: { ...process.env, APP_DIR: path.resolve(app) },
});

const report = fs.existsSync(xml) ? fs.readFileSync(xml, 'utf8') : '';
const result = { id, app: path.resolve(app), at: new Date().toISOString(), failed: [], passed: [], skipped: [] };
for (const m of report.matchAll(/<testcase\b[^>]*\bname="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const caseId = (m[1].match(/^([A-Z]\d+)\b/) || [])[1];
  if (!caseId) continue;
  const inner = m[2] || '';
  if (/<skipped\b/.test(inner)) result.skipped.push(caseId);
  else if (/<failure\b|<error\b/.test(inner)) result.failed.push(caseId);
  else result.passed.push(caseId);
}
fs.writeFileSync(path.join(resultsDir, `${id}.json`), JSON.stringify(result, null, 2));
console.log(`${id}: ${result.failed.length} failed, ${result.passed.length} passed, ${result.skipped.length} skipped`);
console.log(`failed: ${result.failed.join(', ') || 'none'}`);
