# Task Routing (GoldRef, phase 1)

Implementation of `../requirements-and-decisions.md`: one Node + Express server, SQLite, and a one-page UI (D14).

## Run

Requires **Node 22.13 or newer** (uses the built-in `node:sqlite`, so there is no native module to compile).

```
npm install
npm start
```

Open http://localhost:3000. The "Viewing as" switcher at the top toggles between the operator dashboard and each contributor (D27).

Environment overrides: `PORT`, `DB_FILE`, `SETTINGS_FILE` (path relative to this folder).

## Layout

| Path | What it holds |
| --- | --- |
| `config/settings.json` | Every tunable number (delays, drop rate, deadlines, expiry, heartbeat, poll interval, speed multiplier) |
| `data/*.json` | Seed expertise areas, contributors, tasks and scripted engine scenarios; reloaded by Reset |
| `src/db.js` | Schema, the two unique partial indexes (one active assignment per task and per contributor), append-only triggers on events, re-entrant transactions |
| `src/engine.js` | Simulated engine: 5–20 s, 20% never return, random pick; scriptable per task |
| `src/service.js` | Routing loop, compare-and-set transitions, timers, restart recovery, read models |
| `src/server.js` | HTTP API and the ticker |
| `public/` | Operator dashboard and contributor view |
| `var/app.db` | Runtime state (created on first boot) |

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/state` | Tasks, contributors and UI config in one call (used by polling) |
| GET | `/api/tasks`, `/api/tasks/:id` | Detail includes `history` |
| POST | `/api/tasks` | `title, keyword, priority, description?, disclaimers?, estimatedEffort?` |
| POST | `/api/tasks/:id/reroute` | `{ version? }` |
| POST | `/api/tasks/:id/remove` | `{ version? }` |
| POST | `/api/assignments/:id/accept` · `decline` · `complete` | `{ contributorId }` |
| GET | `/api/contributors/:id/work` | Contributor's current offer or work, plus recent assignments |
| POST | `/api/reset` | Wipe and reload seed data (D42) |
| POST | `/api/sim/script` | `{ taskId, answers: [{ after_s, outcome }] }`, where outcome is `never`, `no_match`, `random` or a contributor id |

`version` is optional; when sent and stale, the action is rejected with `STATE_CHANGED`.

## Implementation notes

- Timestamps are stored as real epoch ms. All configured durations are simulated seconds divided by `sim.speed_multiplier`.
- Timers are derived from stored timestamps. A 100 ms ticker (and a catch-up before every action) fires deadlines, 5 s reroute pauses and offer expiry.
- Engine requests are sent only after the transaction that created them commits.
- Restart: on boot, downtime = now − `last_alive_at`. Offer expiry, work clocks (`paused_ms`), routing start and reroute pauses are pushed later by the downtime. In-flight requests are logged as lost and resent with reason `restart`. Each open task gets a `server.restarted` event.
- A clean shutdown (Ctrl+C) writes a final heartbeat, so the downtime is measured accurately.
- Seed tasks are created by `system` and submitted at once. `data/scenarios.json` scripts T-002 to show the unresolved/retry case.
