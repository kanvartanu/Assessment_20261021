# Task routing tests

These are black-box tests, written from `../requirements-and-decisions.md` only, for the cases in its test tables: T1–T14, U1–U12, E1–E16, I1–I24, N1–N13, V1–V14 (hardening) and X1–X14 (feature combinations). `mutation/` holds the mutation testing plan (M01–M95). They talk to the app only through HTTP and its SQLite file. They don't import or read its code.

## Run

Needs Node 22.13 or newer (`node:test`, `node:sqlite`, `fetch`). The app's dependencies must already be installed (`npm install` in the app folder).

```
cd TestCases
npm test            # everything, including E15 (1,000 requests)
npm run test:fast   # everything except E15
npm run test:stats  # E15 only
node --test --test-name-pattern="T9" "tests/*.test.js"   # one case
```

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_DIR` | `../GoldRef` | Folder of the app under test |
| `SERVER_ENTRY` | `src/server.js` | Entry file, relative to `APP_DIR` (run with `node`, not `npm start`) |
| `TEST_SPEED` | `10` | `sim.speed_multiplier` for every suite except E15 (fixed at ×100) |
| `TEST_HOST` | `localhost` | Host the app listens on |
| `E15_REQUESTS` | `1000` | Sample size for E15 |

## How it works

- Each test file starts its own server on a free port. Each server gets a temp folder that holds `data/` (the four seed files), `config/settings.json` and `var/app.db`, passed in as `DATA_DIR`, `SETTINGS_FILE` and `DB_FILE`. Seed tasks and scenarios are empty, so nothing routes unless a test asks for it.
- Every test starts with a Reset. Before creating a task, it scripts the engine for that task id with `POST /api/sim/script`. Scripts end with `never` answers, so the engine never falls back to random.
- Tests are written in simulated seconds. `lib/flow.js` converts them with `TEST_SPEED`. Event gaps are measured from the stored `at` timestamps.
- Restart tests hard-kill the process and start it again on the same database. Their engine uses `never_return_rate: 1`, because scripts live in memory and are lost on restart.

## Files

| Path | Holds |
| --- | --- |
| `lib/routes.js` | Every URL the suite calls. **Change this file if the app's action routes differ** |
| `lib/fixtures.js` | Default contributors (C-01 Ana Lima finance+python, C-02 Priya Shah, C-03 Omar Haddad, C-04 Mei Chen python, C-05 Lars Berg finance) and settings |
| `lib/harness.js` | Start, kill, restart and clean up a server |
| `lib/flow.js` | Scripted task creation, polling, history assertions |
| `lib/db.js` | Direct SQLite checks (T13, N1, U5, I16, I22) |
| `tests/t-core.test.js` | T1–T10, T13, T14 |
| `tests/restart.test.js` | T11, T12, U7, E4–E7, I17–I19, X2, X8, X14 |
| `tests/u-user-cases.test.js` | U1–U6, U8–U12 |
| `tests/e-edge.test.js` | E1–E3, E8–E14, E16 |
| `tests/e15-engine-stats.test.js` | E15 |
| `tests/i-implementation.test.js` | I1–I16, I20–I23 |
| `tests/n-new-cases.test.js` | N1–N13 (added with this suite) |
| `tests/v-hardening.test.js` | V1–V14: injection, type confusion, pollution, floods, traversal |
| `tests/x-combinations.test.js` | X1, X3–X7, X9–X13: feature combinations |
| `mutation/mutations.json` | The 95 planned mutations and the tests predicted to kill each one |
| `mutation/check.js` | Checks the plan (`node mutation/check.js`), compares results (`--observed`), prints the doc table (`--markdown`) |
| `mutation/run.js` | Runs the suite against one mutant copy and saves the failing test ids to `mutation/results/` |
| `MANUAL.md` | UI-only checks: banners, hidden buttons, fixed messages, I24 |

## Mutation testing

```
node mutation/check.js                              # plan: every mutation killed, no two with the same kill set
node mutation/run.js --id baseline --app ../GoldRef # must pass everything first
node mutation/run.js --id M07 --app <mutant copy>   # one copy of the app per mutation
node mutation/check.js --observed                   # survivors and duplicate kill sets
```

## Assumptions

The doc doesn't fix the details below, so the suite assumes them. They are also listed in the doc under "Assumptions the test suite makes".

- Action routes: `POST /api/tasks/:id/reroute`, `POST /api/tasks/:id/remove` (body `{ version? }`), `POST /api/assignments/:id/accept|decline|complete` (body `{ contributorId }`), `POST /api/reset`.
- `settings.json` nests the dotted names (`{ "engine": { "min_delay_s": 5 } }`, `routing.deadline_s` as `{ high, normal, low }`).
- `expertise-areas.json` is an array of strings. `contributors.json` entries are `{ name, keywords }`, and ids follow file order.
- `/api/state` returns `{ tasks, contributors: [{ id, name, ... }] }`. Create and detail responses are the task itself or `{ task }`.
- The DB tables are named `tasks`, `contributors`, `assignments` and `events`, with the columns `task_id`, `contributor_id` and `status`.
- U7 waits 60 s of work instead of 4 min. The behaviour checked is the same.
