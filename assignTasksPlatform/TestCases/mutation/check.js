'use strict';
// Checks the mutation plan in mutations.json.
//   node mutation/check.js             predicted kill sets: non-empty, pairwise distinct, every test id exists
//   node mutation/check.js --observed  compare results/*.json from run.js with the prediction
//   node mutation/check.js --markdown  print the doc's mutation table
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const mutations = JSON.parse(fs.readFileSync(path.join(HERE, 'mutations.json'), 'utf8'));
const key = (ids) => [...new Set(ids)].sort(byId).join(',');

function byId(a, b) {
  const [, pa, na] = a.match(/^([A-Z]+)(\d+)/) || [, a, 0];
  const [, pb, nb] = b.match(/^([A-Z]+)(\d+)/) || [, b, 0];
  return pa === pb ? Number(na) - Number(nb) : pa.localeCompare(pb);
}

function testIdsInSuite() {
  const dir = path.join(HERE, '..', 'tests');
  const ids = new Set();
  for (const file of fs.readdirSync(dir).filter((n) => n.endsWith('.test.js'))) {
    for (const m of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/\bit\(\s*['"`]([A-Z]\d+)\b/g)) ids.add(m[1]);
  }
  return ids;
}

function duplicates(sets) {
  const seen = new Map();
  for (const [id, ids] of sets) {
    const k = key(ids);
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(id);
  }
  return [...seen.entries()].filter(([, ms]) => ms.length > 1);
}

function checkPredicted() {
  const suite = testIdsInSuite();
  let problems = 0;
  for (const m of mutations) {
    if (!m.kills.length) { console.log(`${m.id}: no predicted kill`); problems++; }
    for (const t of [...m.kills, ...(m.mayKill || [])]) {
      if (!suite.has(t)) { console.log(`${m.id}: test ${t} does not exist in tests/`); problems++; }
    }
  }
  for (const [k, ms] of duplicates(mutations.map((m) => [m.id, m.kills]))) {
    console.log(`same predicted kill set {${k}}: ${ms.join(', ')}`);
    problems++;
  }
  const covered = new Set(mutations.flatMap((m) => m.kills));
  const unused = [...suite].filter((t) => !covered.has(t)).sort(byId);
  console.log(`${mutations.length} mutations, ${new Set(mutations.map((m) => key(m.kills))).size} distinct kill sets, ` +
    `${mutations.filter((m) => m.kills.length === 1).length} with a single-test signature`);
  console.log(`tests that kill no planned mutation (deterministically): ${unused.join(', ') || 'none'}`);
  console.log(problems ? `${problems} problem(s)` : 'plan OK');
  process.exitCode = problems ? 1 : 0;
}

function checkObserved() {
  const dir = path.join(HERE, 'results');
  const load = (id) => {
    const file = path.join(dir, `${id}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  const baseline = load('baseline');
  if (!baseline) { console.log('No results/baseline.json. Run: node mutation/run.js --id baseline --app <unmutated app>'); process.exitCode = 1; return; }
  const noise = new Set(baseline.failed);
  if (noise.size) console.log(`baseline already fails: ${[...noise].join(', ')} (ignored below)`);
  const observed = [];
  let survived = 0;
  for (const m of mutations) {
    const r = load(m.id);
    if (!r) { console.log(`${m.id}: not run`); continue; }
    const failed = r.failed.filter((t) => !noise.has(t));
    const races = new Set(m.mayKill || []);
    const firm = failed.filter((t) => !races.has(t));
    observed.push([m.id, firm]);
    const missing = m.kills.filter((t) => !failed.includes(t));
    const extra = firm.filter((t) => !m.kills.includes(t));
    const status = failed.length ? 'killed' : 'SURVIVED';
    if (!failed.length) survived++;
    console.log(`${m.id}: ${status} by {${failed.join(', ')}}` +
      (missing.length ? `; predicted but passed: ${missing.join(', ')}` : '') +
      (extra.length ? `; not predicted: ${extra.join(', ')}` : ''));
  }
  for (const [k, ms] of duplicates(observed)) console.log(`same observed kill set {${k}}: ${ms.join(', ')}`);
  console.log(survived ? `${survived} mutation(s) survived: add or tighten tests` : 'every run mutation was killed');
  process.exitCode = survived ? 1 : 0;
}

function markdown() {
  console.log('| # | File | Mutation | Killed by | May also fail (races) |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const m of mutations) {
    const note = m.note ? ` (${m.note})` : '';
    console.log(`| ${m.id} | \`${m.file}\` | ${m.mutation}${note} | ${m.kills.join(', ')} | ${(m.mayKill || []).join(', ')} |`);
  }
}

if (process.argv.includes('--observed')) checkObserved();
else if (process.argv.includes('--markdown')) markdown();
else checkPredicted();
