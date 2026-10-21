# Task Routing — Requirements & Open Decisions

Oct 21, 2026 · @Tanu

> Exported from the living doc on 2026-10-22: https://claude.ai/artifact/GM1LGyDXinfQVgt7ccb3Pp. The lifecycle diagram is reproduced below as Mermaid.

## Purpose

All open questions are answered, so Phase 1 can start. This doc separates three things: what the brief states, where the current understanding differs from it, and the decisions still to make.

- **Brief says** = quoted from the assessment text, not interpreted.
- **Proposal** = my recommendation, not adopted until you confirm it.
- **Decision** = confirmed by you and logged in the decisions log.

## What the brief actually says

The brief settles these points directly. Everything else is ours to decide.

| Topic | Brief says (quoted) | What it means |
| --- | --- | --- |
| Late response after intervention | "the operator intervenes while routing is pending, and the outstanding request may still return afterward" | The response **will** arrive sometimes. The brief does **not** say what to do with it. "Ignore it" was my proposal, not the brief. Decided in D5. |
| Unresolved | "20% of routing requests never return. They do not report an error or announce that they are stuck; they simply remain unresolved." | Unresolved = no result, no no-match, no error, ever. The request just stays pending. |
| Slow vs lost | "A routing request normally takes between 5 and 20 seconds" · "The operator cannot know whether a particular pending request is slow or will never return." | 80% return in 5–20 s. 20% never return. Nothing distinguishes them while pending. |
| One assignee | "each task can have at most one active assignee. Once a contributor accepts an assignment, routing for that task is complete." | 0 or 1 active contributor per task at any moment. A task can still have several assignments over its life (one declined, then another). |
| Expertise | "Each task requires an area of expertise. Each contributor has one or more areas of expertise." | One task = exactly one area. Many tasks can share an area. A contributor can hold several. |
| Priority | Only "a high-priority task remains pending" | A priority exists, but the brief names no levels and no owner. Decided in D23. |
| Who picks the contributor | "The engine receives the task and the contributors whose areas of expertise match it ... it selects one of the eligible contributors or reports that no match was found." | The **engine** selects. Contributors do not browse and pick tasks. |
| Operator dashboard | "See tasks with their time since created, contributors, and the current state of the operation." | The dashboard is the **operator's** view of the whole operation. |
| Recovery | "an assignment is declined or fails before work begins, and the operator needs to understand what happened and decide what to do next" | After a decline or failure, the operator decides. Nothing is required to happen automatically. |

## Corrections and disagreements

The biggest difference: the brief describes a **push** model (the engine offers a task to one contributor) and an **operator** console. The current understanding describes a **pull** marketplace where contributors browse a pool. All points are now settled in the decisions log.

| # | Current understanding | My view | Why (from the brief) |
| --- | --- | --- | --- |
| C1 | Late responses are ignored, per the brief | Correction: that was my proposal. The brief only says they can arrive. | Quote in section 2. Handled by D5. |
| C2 | A contributor arrives at a task and takes it | Disagree. The engine selects one contributor, who then accepts or declines that offer. | "it selects one of the eligible contributors"; "Once a contributor accepts an assignment" |
| C3 | The dashboard lists open tasks for contributors to take | Disagree. The dashboard is the operator's console. | "The product should let an operator: See tasks ... contributors, and the current state of the operation" |
| C4 | Tasks being worked on disappear from the dashboard | Disagree. Hiding them stops the operator monitoring or intervening. Decided (D16): the dashboard lists every task. | "Intervene in an assignment whenever they want"; "Inspect enough history" |
| C5 | Assignments are only visible to the accepted contributor, never on the dashboard | Disagree for the operator, agree for other contributors. The operator must see assignments to intervene. A contributor view shows only that contributor's own offers and work. | "Intervene in an assignment whenever they want" |
| C6 | Completed tasks are removed | Decided (D25): completed tasks are kept with full history. | "Inspect enough history to understand what happened" |
| C7 | A rejected or cancelled assignment releases the task back to the active pool | Decided (D4): reroute automatically. The history shows why, and the operator can step in. | "the operator needs to understand what happened and decide what to do next" |
| C8 | Clicking an occupied task shows an error | Agree on the lock, but the race is different. It is between engine responses, operator actions and contributor accept/decline, not contributors clicking the same task. Section 6. | "at most one active assignee" |
| C9 | At most one contributor per task | Agree. I should have stated it explicitly. Section 6 enforces it in the database. | Same quote |
| C10 | Priority was missing as a field | Agree, it was missing. Now in section 4. | "a high-priority task" |
| C11 | 20% drop rate was missing | Agree, it was only implied. It is now an explicit parameter in section 7. | "20% of routing requests never return" |
| C12 | Auto-retry routing when there is no response | Agree it is a fair product choice. "No response" can only mean "no response within a deadline" we choose. Decided in D22. | "cannot know whether ... slow or will never return" |
| C13 | Operator intervention includes notifications and aborting | Decided (D11): phase 1 has Reroute now and Remove contributor. No notifications in phase 1 (D18). | Brief lists intervening and recovering, not notifying |
| C14 | A contributor "submits" a task to start it | I read this as "accepts". Work is submitted at the end, when it is completed. See D24 and D26. | "Once a contributor accepts an assignment" |

## Domain model

Four tables, with routing state kept on the task itself (D5). A task never holds a contributor directly; the link always goes through an **assignment**, so earlier declines and expiries stay in the record.

| Record | Fields | Notes |
| --- | --- | --- |
| Task | id, title, description, keyword, priority, disclaimers, status, created_at, current_request_id, routing_started_at, routing_deadline_at, next_routing_at (end of the 5 s pause, E4), overdue (flag), request_count, version | Age on the dashboard = now − created_at |
| Contributor | id, name, keywords (one or more), current_assignment_id (null when free, D35) | Seeded from `data/contributors.json` |
| Assignment | id, task_id, contributor_id, status (offered / accepted / completed / declined / expired / removed), offered_at, offer_expires_at, accepted_at, ended_at, reason | At most one offered or accepted assignment per task |
| Event | id, task_id, assignment_id?, request_id?, actor (system / engine / operator / contributor), type, details, at | Append-only; this is the task's history |

A one-row `meta` table holds the `last_alive_at` heartbeat for restarts (D12). The simulated engine keeps its pending timers in memory only.

## Lifecycle

Phase 1 has five states and no dead ends: every failure reroutes automatically (D3, D4, D8). Overdue is a flag on a Routing task, not a state of its own.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Created
    Created --> Routing: submit
    Routing --> Routing: retry after deadline, or no match
    Routing --> Offered: match
    Offered --> InProgress: accepts
    Offered --> Routing: declined, expired, or contributor removed
    InProgress --> Routing: contributor removed mid-work
    InProgress --> Completed: completes
    Completed --> [*]
    state "In progress" as InProgress
```

A Routing task past its deadline shows an Overdue flag; the operator can click Reroute now at any time.

Routing, Offered and In progress are where the engine, the contributor and the operator can act at the same moment, so all the races in the concurrency section happen there.

## Concurrency: the one-assignee lock

The database enforces the lock, not the UI. A second writer loses cleanly and gets a clear error. Two layers do this:

1. **Unique partial index** on assignments(task_id) where status is offered, accepted or in_progress. A second active assignment for the same task is physically impossible.
2. **Compare-and-set on the task**: every change runs `UPDATE task SET ... , version = version + 1 WHERE id = ? AND version = ? AND status = ?` in one transaction. If zero rows change, someone else moved first. The caller gets **409 Conflict** with the task's current state, and the UI shows it ("Priya accepted this offer 3 s ago").

A third guard covers contributors (D35): a **unique partial index** on assignments(contributor_id) for active statuses, so one person can never hold two tasks. The `current_assignment_id` field on the contributor is the quick lookup, written in the same transaction.

The races this has to handle:

| Race | Example | Outcome |
| --- | --- | --- |
| Stale engine answer vs Reroute now | Operator clicks Reroute now at 12 s; the first request answers at 15 s | The answer's request id no longer matches, so it is logged and ignored (D5) |
| Stale answer vs auto-retry | Request 1 is slow, request 2 starts at the deadline, both answer | Only the current request counts; request 1 is logged and ignored (D5) |
| Contributor accepts vs operator removes | Both click within the same second | First write wins. Accept first: the removal still applies after a confirmation. Removal first: the contributor sees "This offer is no longer available." |
| Contributor completes vs operator removes | Both click within the same second | Complete first: removal fails with "Already completed." Removal first: the contributor sees "You were removed from this assignment; your submission wasn't recorded." |
| Contributor accepts vs offer expiry | Accept lands as the expiry timer fires | First write wins; the losing side is logged |
| Two operator tabs | Both click Reroute now | One wins; the other gets 409 and a refreshed view |
| One contributor, two offers | Two tasks offered to the same person at once | Impossible: once the first offer lands the contributor is no longer free, so the second pick is logged as routing.pick_unavailable and the task reroutes (D35, D36) |

An offered assignment already holds the lock (D17): the engine's pick is the task's one assignee until the task is rerouted or completed.

## Output formats

These formats are what the tests check, so they are fixed before any code is written. Ids, timestamps and durations follow D36.

### History event (stored and returned by the API)

```json
{
  "id": 42,
  "taskId": "T-003",
  "at": "2026-10-22T14:03:07.412Z",
  "actor": "engine",
  "type": "routing.answered",
  "requestId": "R-003-2",
  "assignmentId": null,
  "details": { "contributorId": "C-02", "latencySeconds": 12.4 }
}
```

`actor` is one of `system`, `engine`, `operator`, `contributor`. `details` holds only the fields listed for that type below.

### Event types

The timeline shows one line per event: `HH:MM:SS  ACTOR  <display line>`.

| type | actor | details | Display line |
| --- | --- | --- | --- |
| `task.created` | operator | keyword, priority | Task created (keyword python, priority high) |
| `routing.requested` | system | reason, eligibleCount | Routing request R-003-1 sent (reason: submit, 3 eligible) |
| `routing.answered` | engine | contributorId, latencySeconds | R-003-1 answered after 12.4 s: Priya Shah |
| `routing.no_match` | engine | latencySeconds | R-003-1 answered after 8.1 s: no match |
| `routing.overdue` | system | deadlineSeconds | R-003-1 overdue: no answer after 25 s |
| `routing.stale_ignored` | engine | currentRequestId, outcome | Late answer from R-003-1 ignored (current request is R-003-2) |
| `routing.lost_on_restart` | system | downtimeSeconds | R-003-2 lost when the server restarted |
| `assignment.offered` | system | contributorId, expiresInSeconds | Offered to Priya Shah; expires in 120 s |
| `assignment.accepted` | contributor | contributorId | Accepted by Priya Shah |
| `assignment.declined` | contributor | contributorId | Declined by Priya Shah |
| `assignment.expired` | system | contributorId | Offer to Priya Shah expired after 120 s |
| `assignment.removed` | operator | contributorId, wasStatus | Operator removed Priya Shah (was: in progress) |
| `assignment.completed` | contributor | contributorId, workSeconds | Completed by Priya Shah after 6 min 12 s |
| `operator.reroute_now` | operator | requestId | Operator clicked Reroute now (cancels R-003-1) |
| `action.rejected` | system | attemptedBy, action, code | Accept by Priya Shah rejected: OFFER_NO_LONGER_AVAILABLE |
| `server.restarted` | system | downtimeSeconds | Server restarted after 34 s down; timers extended by 34 s |
| `routing.pick_unavailable` | system | contributorId, busyOnTaskId | R-003-2 picked Priya Shah, who is busy on T-001; treated as no match |

`routing.requested` reasons: `submit`, `retry_deadline`, `no_match`, `declined`, `expired`, `removed`, `operator_reroute`, `restart`. The task's completion is shown by `assignment.completed`; there is no separate task event.

### Task (GET /api/tasks and /api/tasks/:id)

```json
{
  "id": "T-003",
  "title": "Clean the claims dataset",
  "description": "...",
  "keyword": "python",
  "priority": "high",
  "disclaimers": "Contains anonymised patient data.",
  "estimatedEffort": "2 hours",
  "status": "routing",
  "createdAt": "2026-10-22T14:00:01.000Z",
  "ageSeconds": 312,
  "overdue": true,
  "currentRequestId": "R-003-2",
  "requestCount": 2,
  "routingElapsedSeconds": 31,
  "assignee": null,
  "version": 7
}
```

`status` is one of `created`, `routing`, `offered`, `in_progress`, `completed`. When there is an assignee, `assignee` is `{ "assignmentId": "A-011", "contributorId": "C-02", "name": "Priya Shah", "status": "offered", "offerExpiresInSeconds": 84, "workSeconds": null }`. The detail endpoint adds `"history": [ <events, oldest first> ]`.

### Errors

Every rejected action returns `{ "error": { "code": "<CODE>", "message": "<UI text>" }, "task": <current task> }`.

| HTTP | code | message shown in the UI |
| --- | --- | --- |
| 409 | `OFFER_NO_LONGER_AVAILABLE` | This offer is no longer available. |
| 409 | `ALREADY_COMPLETED` | This task is already completed. |
| 409 | `REMOVED_FROM_ASSIGNMENT` | You were removed from this assignment; your submission wasn't recorded. |
| 409 | `STATE_CHANGED` | This task changed while you were looking at it. The view has been refreshed. |
| 400 | `VALIDATION_FAILED` | Names the first invalid field, e.g. "keyword must be one of: finance, python" |
| 404 | `NOT_FOUND` | Task not found. |
| 409 | `NOT_ROUTING` | This task isn't routing right now. Use Remove contributor instead. |
| 403 | `NOT_YOUR_OFFER` | This offer belongs to another contributor. |

### Fixed UI messages

- Banner while the server is unreachable: **Server unreachable. Timers are paused and will resume when the connection returns.**
- Overdue badge on a task: **Overdue · no answer for 31 s**
- Remove contributor confirmation: **Priya Shah is working on this. Remove them and reroute?**

## Test cases

Each test scripts the engine's answer (delay and outcome, or "never") so the run is deterministic. Each test passes only if the task's history contains exactly the listed event types in order, and the task ends in the listed state. Timers run with `sim.speed_multiplier` so a test takes seconds, not minutes.

| # | Use case | Engine script and actions | History (event types, in order) | Final state |
| --- | --- | --- | --- | --- |
| T1 | Routine | Answer C-02 after 8 s → C-02 accepts → C-02 completes | task.created, routing.requested(submit), routing.answered, assignment.offered, assignment.accepted, assignment.completed | completed, assignee C-02 |
| T2 | Unresolved | High priority; request 1 never answers; request 2 answers C-02 after 6 s | task.created, routing.requested(submit), routing.overdue, routing.requested(retry_deadline), routing.answered, assignment.offered | offered; overdue cleared |
| T3 | Late answer after retry | Request 1 answers after 30 s; request 2 (started at 25 s) answers C-03 after 3 s | … routing.overdue, routing.requested(retry_deadline), routing.answered (R-2), assignment.offered, routing.stale_ignored (R-1) | offered to C-03, not changed by R-1 |
| T4 | Intervention while pending | Operator clicks Reroute now at 10 s; request 1 answers at 15 s | … operator.reroute_now, routing.requested(operator_reroute), routing.stale_ignored (R-1) | routing, waiting on R-2 |
| T5 | Recovery: decline | Answer C-02 → C-02 declines; next answer C-03 | … assignment.offered, assignment.declined, routing.requested(declined) 5 s later with C-02 excluded, routing.answered, assignment.offered | offered to C-03 |
| T6 | Recovery: expiry | Answer C-02 → no reply for 120 s | … assignment.offered, assignment.expired, routing.requested(expired) | routing |
| T7 | No match | No eligible contributor | task.created, routing.requested(submit), routing.no_match, routing.requested(no_match) 5 s later, repeating | routing |
| T8 | Remove mid-work | C-02 accepted → operator removes C-02 | … assignment.accepted, assignment.removed, routing.requested(removed) | routing, no assignee |
| T9 | Race: accept vs remove | Both sent together | One of: (accepted, removed, requested) or (removed, action.rejected OFFER_NO_LONGER_AVAILABLE, requested) | routing; never two assignees |
| T10 | Race: complete vs remove | Both sent together | One of: (completed, action.rejected ALREADY_COMPLETED) or (removed, action.rejected REMOVED_FROM_ASSIGNMENT, requested) | completed or routing |
| T11 | Restart mid-routing | Stop the server 10 s into a request; restart after 30 s | … routing.requested(submit), server.restarted, routing.lost_on_restart, routing.requested(restart) | routing; deadline counted from restart |
| T12 | Restart during offer | Offer at 20 s of 120; server down 60 s | … assignment.offered, server.restarted | offered; 100 s still left on the offer |
| T13 | One-assignee invariant | Insert a second active assignment directly into the database | Insert refused by the unique index | unchanged |
| T14 | Two tasks at once | Submit T-001 and T-002 together; both answer C-02 | T-002: … routing.answered, routing.pick_unavailable, routing.requested(no_match) 5 s later | T-001 offered to C-02, T-002 routing |

## Your edge cases

All 12 are now tests (U1–U12). Three use features that phase 1 doesn't have (operator cancel, contributor cancel, adding contributors at runtime). They are tested as the closest phase 1 behaviour (D37–D39).

| # | Your case | Setup and actions | History (event types, in order) | Final state and checks |
| --- | --- | --- | --- | --- |
| U1 | Contributor assigned by engine shows on the operator dashboard | Engine answers C-02 after 8 s | task.created, routing.requested(submit), routing.answered, assignment.offered | Within 1 poll (1 s) the dashboard row shows status offered, assignee C-02, offer countdown from 120 s |
| U2 | Contributor never opens the offer and it expires | Engine answers C-02; C-02 does nothing for 120 s | … assignment.offered, assignment.expired, routing.requested(expired) 5 s later | routing; C-02 free again; C-02 excluded from the next pick (D31). Same as T6 |
| U3 | Contributor accepts or submits while the operator acts | Phase 1 has no operator cancel, so the operator side is **Remove contributor** (D37). Three races: accept vs remove, complete vs remove, accept vs expiry | See T9 and T10; for accept vs expiry, one of: (accepted) or (expired, action.rejected OFFER_NO_LONGER_AVAILABLE, requested) | Never two assignees; the loser gets the 409 message; exactly one of the two outcomes appears in history |
| U4 | Answer arrives at 70 s after a retry was sent at 60 s | Low priority (deadline 60 s); request 1 answers C-02 at 70 s; request 2 pending | … routing.requested(submit), routing.overdue (60 s), routing.requested(retry_deadline), routing.stale_ignored (R-1 at 70 s) | routing, waiting on R-2; C-02 not offered by the stale answer |
| U5 | Several tasks picked for one contributor (D38) | T-001, T-002, T-003 submitted together; all three requests answer C-02 | T-001: … assignment.offered. T-002 and T-003: … routing.answered, routing.pick_unavailable, routing.requested(no_match) | Only T-001 holds C-02; the database never shows C-02 on two tasks |
| U6 | No match, two more tries, then a contributor becomes available | The only python contributor C-03 is busy on T-001. Submit python task T-002; C-03 completes T-001 after the third no match | T-002: routing.requested(submit), routing.no_match, routing.requested(no_match), routing.no_match, routing.requested(no_match), routing.no_match, routing.requested(no_match), routing.answered, assignment.offered | offered to C-03; 3 no_match events, each followed 5 s later by a new request. "Appears" = becomes free, since phase 1 can't add contributors at runtime |
| U7 | Restart while a contributor is working | C-02 has worked 4 min; stop server for 60 s; restart | … assignment.accepted, server.restarted (downtime 60 s) | in_progress, still C-02. Work clock reads 4 min after restart (pauses through downtime, D39). While down, the contributor's assignment page and the operator's task panel show the unreachable banner |
| U8 | Operator revokes while the contributor is working | C-02 accepted; operator clicks Remove contributor and confirms | … assignment.accepted, assignment.removed (wasStatus in_progress), routing.requested(removed) 5 s later | routing; C-02 free; C-02's next Complete gets REMOVED_FROM_ASSIGNMENT. Same as T8 |
| U9 | Reroute now while routing is already running | Operator clicks Reroute now at 10 s into R-1; R-1 answers at 15 s | … operator.reroute_now, routing.requested(operator_reroute), routing.stale_ignored (R-1) | routing on R-2; requestCount 2. Same as T4 |
| U10 | Multiple assignments in one task | Engine picks C-01 (declines), then C-02 (lets it expire), then C-04 (accepts, completes) | … offered, declined, requested(declined), … offered, expired, requested(expired), … offered, accepted, completed | completed by C-04. The task has 3 assignment records (declined, expired, completed) and never more than 1 active at a time |
| U11 | Contributor cancels, then the history is checked (D37) | Contributors can't cancel after accepting in phase 1 (D21), so this is a **decline** | Exact sequence compared field by field against the expected list: types, actors, contributorId, requestId, reasons | History is append-only: a later reroute adds events and never edits or removes earlier ones |
| U12 | One contributor with both keywords, two tasks with different keywords | C-01 has finance and python; T-001 finance and T-002 python submitted together; C-01 is the only eligible contributor for both | First answer: offered to C-01. Second: routing.pick_unavailable, then no_match repeats until C-01 is free | The engine does nothing special: each request picks from contributors who are free when it was sent. The app's one-task rule (D35) decides |

## Additional edge cases

These 16 come from combining features. E8, E12 and E14 follow D40–D42.

| # | Edge case | Setup and actions | Expected |
| --- | --- | --- | --- |
| E1 | Everyone eligible declines | Two python contributors, both decline in turn | Third request starts over with both (D31); history shows 2 declines, then a new offer |
| E2 | Stale answer after the task is completed | R-1 overdue, R-2 leads to completion, R-1 answers afterwards | routing.stale_ignored; task stays completed; nobody gets an offer |
| E3 | Stale answer names a busy contributor | R-1 (stale) picks C-02 while C-02 works on another task | routing.stale_ignored only; no pick_unavailable, no change to C-02 |
| E4 | Restart during the 5 s reroute pause | Decline at t=0, server down at t=2 s for 30 s | After restart the new request starts 3 s later, not at once and not lost. Needs `next_routing_at` stored on the task |
| E5 | Restart while a request is overdue | Request 30 s old with a 25 s deadline; restart | routing.lost_on_restart, routing.requested(restart); overdue flag cleared for the new request |
| E6 | Two restarts in a row | Server down 20 s, up 2 s, down 20 s | Two server.restarted events; offer clocks extended by 40 s in total |
| E7 | Offer expiry lands during downtime | Offer has 10 s left; server down 60 s | After restart the offer still has 10 s left (D12), then expires normally |
| E8 | Wrong contributor acts (D41) | C-03 calls Accept on C-02's offer | 403 `NOT_YOUR_OFFER`; action.rejected logged; offer unchanged |
| E9 | Double click on Accept or Complete | Same request sent twice within 100 ms | One assignment.accepted; the second call gets 409 `STATE_CHANGED`; no duplicate event |
| E10 | Remove contributor on a completed task | Operator clicks Remove after completion (two tabs) | 409 `ALREADY_COMPLETED`; history unchanged except action.rejected |
| E11 | Two operator tabs click Reroute now | Both within the same second | One operator.reroute_now and one new request; the other tab gets 409 `STATE_CHANGED` |
| E12 | Reroute now on a task that isn't routing (D40) | Task is offered or in progress | Button hidden; API returns 409 `NOT_ROUTING` |
| E13 | Invalid task creation | Keyword "healthcare", empty title, priority "urgent" | 400 `VALIDATION_FAILED`, naming the first invalid field; no task, no event |
| E14 | Reset while work is active (D42) | Tasks routing and in progress; operator clicks Reset | Database reloaded from seed files; answers that arrive afterwards for old request ids are dropped without error |
| E15 | Engine statistics | 1,000 scripted-random requests at speed ×100 | 20% ± 3% never answer; every answer arrives between 5 and 20 s (simulated) |
| E16 | Deadline per priority | One high, one normal, one low task; engine never answers | Overdue and retry at 25 s, 40 s and 60 s respectively |

## Configuration and data files

Agreed: no tasks, contributors or tunable numbers in code. Seed data and parameters live in files a developer edits. Runtime records (tasks created later, assignments, events) live in the database, never in code or seed files.

| File | Holds | Example contents |
| --- | --- | --- |
| `data/expertise-areas.json` | The allowed areas | finance, python |
| `data/contributors.json` | Seed contributors | name, keywords |
| `data/tasks.json` | Seed tasks | title, description, keyword, priority, disclaimers, estimated effort |
| `data/scenarios.json` | Scripted demo cases | "engine never returns for task X", "contributor Y declines" |
| `config/settings.json` | Every tunable number | see below |
| SQLite file (`var/app.db`) | Runtime state | tasks, contributors, assignments, events, meta |

Parameters planned for `config/settings.json`. All values are confirmed:

| Parameter | Value | Meaning |
| --- | --- | --- |
| engine.min_delay_s / max_delay_s | 5 / 20 | Brief's normal answer range |
| engine.never_return_rate | 0.20 | Brief's drop rate, sampled per request |
| routing.deadline_s | high 25 / normal 40 / low 60 | After this, the request is flagged Overdue and retried (D22) |
| routing.reroute_delay_s | 5 | Pause before rerouting after no match, decline, expiry or removal (D30) |
| offer.expiry_s | 120 | An unanswered offer expires and the task reroutes (D20) |
| heartbeat.interval_s | 2 | How often `last_alive_at` is written (D12) |
| ui.poll_interval_ms | 1000 | How often pages refresh |
| sim.speed_multiplier | 1 | Speeds up all timers for demos and tests |

One task per contributor is a fixed rule (D35), not a setting.

All files are JSON (D28).

## Open questions

None. All 37 questions are answered and recorded in the decisions log.

## Decisions log

42 decisions are confirmed. Each one overrides anything earlier in this doc that conflicts with it.

| # | Decision |
| --- | --- |
| D1 | Routing retries automatically when a request gets no answer by its deadline. The task is flagged **Overdue** and the operator gets a **Reroute now** button. |
| D2 | Tasks, contributors and settings live in data/config files. Runtime records live in SQLite. |
| D3 | No match → reroute automatically, and keep rerouting until a contributor is found. |
| D4 | Declined or expired offer → reroute automatically. |
| D5 | One routing slot per task: the task stores `current_request_id`. An answer with any other id is stale; it is logged and ignored. No separate routing table. |
| D6 | One history (event log) per task covers routing, offers, contributor actions and operator actions. |
| D7 | Matching by keyword: one keyword per task, one or more per contributor. Eligible = has the task's keyword. The engine picks one eligible contributor at random, who must then accept. |
| D8 | Routing ends when a contributor accepts. The task ends when that contributor completes the assignment, and is marked Completed. If the contributor is removed mid-work, routing starts again. |
| D9 | The record stays named **assignment**, as in the brief. |
| D10 | Timers are computed on the server from stored timestamps and run whether or not anyone is viewing. Tasks have a disclaimers field. |
| D11 | Phase 1 operator actions: **Reroute now**, and **Remove contributor** (revoke an offer or take the contributor off active work). Other actions are future work. |
| D12 | Restart, cheap version: the server writes a `last_alive_at` heartbeat. On boot it pushes open deadlines later by the downtime, so timers pause. In-flight routing requests are retried and logged. Pages show a banner while the server is unreachable. |
| D13 | Races: the first write to reach the database wins; the loser gets a clear message (HTTP 409). |
| D14 | Simple stack: one Node + Express server, SQLite, a one-page UI. |
| D15 (Q2) | Push model: the engine sends the offer to one contributor, who accepts or declines. |
| D16 (Q3) | The operator dashboard lists every task, completed or not. |
| D17 (Q4) | A task has exactly 0 or 1 assignee. The contributor the engine picks becomes the assignee at once (already at the offer) and stays until the task is rerouted or completed. |
| D18 (Q15) | No operator note or notifications in phase 1. |
| D19 (Q5) | Superseded by D35. |
| D20 (Q6) | An offer stays open 120 s, then expires and the task reroutes. |
| D21 (Q7) | No "can't start" action in phase 1; Decline covers it before acceptance. |
| D22 (Q10) | Routing deadline before retry: high 25 s, normal 40 s, low 60 s. |
| D23 (Q11) | Priority levels low / normal / high, set by the operator at creation. |
| D24 (Q12) | Before accepting, the contributor sees title, keyword, priority, description, disclaimers and estimated effort. |
| D25 (Q13) | Completed tasks are kept, with full history. |
| D26 (Q14) | Accepted work has a running clock but no time limit. |
| D27 (Q17) | The contributor side is a "viewing as" switcher in the same app, no login. |
| D28 (Q18) | Data and settings files are JSON. |
| D29 (Q19) | Seed data loads on first boot; a Reset button reloads it. |
| D30 (Q22) | 5 s pause before rerouting after no match, decline, expiry or removal. |
| D31 (Q23) | Rerouting skips contributors who already declined the task; once all eligible have declined, it starts over with all of them. |
| D32 (Q24) | Creating a task submits it in the same action. |
| D33 (Q25, Q26) | Removing a contributor reroutes automatically, like a decline. The dashboard has a contributors panel showing keywords and current work. |
| D34 (Q30) | Two keywords only: finance and python. |
| D35 | A contributor is on at most one task at a time, offers included. The contributor record holds current_assignment_id (null when free), set and cleared in the same transaction as the assignment. A unique index on active assignments per contributor guarantees it. Only free contributors are eligible. |
| D36 (Q27–Q29, Q31) | Readable ids (T-001, C-01, A-001, R-003-2); UTC in the API, local HH:MM:SS in the UI; durations as "12.4 s" or "6 min 12 s". If the engine picks a contributor who is no longer free, log routing.pick_unavailable and reroute after 5 s. |
| D37 (Q32) | "Operator cancels" is tested as Remove contributor and "contributor cancels" as Decline; real cancel stays future work. |
| D38 (Q33) | "Several ids to 1 contributor" means several tasks picked for the same contributor at once (U5). |
| D39 (Q34) | The work clock pauses during downtime, like offer expiry. |
| D40 (Q35) | Reroute now works only while a task is routing; otherwise the API returns NOT_ROUTING. |
| D41 (Q36) | A contributor acting on someone else's offer gets 403 NOT_YOUR_OFFER, and it is logged. |
| D42 (Q37) | Reset wipes the database and reloads seed data even while work is active; late answers for old request ids are dropped. |

## Phases

Phase 1 builds the smallest product that covers all four use cases in the brief. Phase 2 verifies it and packages the submission. Everything else is future work.

**Phase 1: build the core (keep it simple)**

1. Scaffold: Node + Express + SQLite, one HTML page, `config/settings.json`, and a loader for `data/*.json`.
2. Data and state: tables for tasks, contributors, assignments and events. One transition function with compare-and-set, plus the one-active-assignment index.
3. Simulated engine: answers in 5–20 s or never (20%), picks one eligible contributor at random, tagged with a request id.
4. Routing loop: start on submit, retry after the deadline with an Overdue flag, reroute on no match, decline or expiry, ignore stale answers.
5. Contributor view: a "viewing as" switcher, the offer with task details and disclaimers, Accept / Decline, and the assignment page with its clock and Complete button.
6. Operator dashboard: task table (keyword, priority, state, age, routing timer, flags), create-task form, task panel with history, and the **Reroute now** and **Remove contributor** buttons.
7. Restart: heartbeat, timers paused through downtime, lost requests retried, unreachable banner.

**Phase 2: verify and submit**

1. Automated tests for transitions and races: stale answer, accept vs remove, complete vs remove.
2. Walk through the four use cases by hand, including a restart mid-routing.
3. README with decisions, assumptions and omissions; session map; Loom walkthrough.

## Future work

These items are deliberately left out of phase 1 and will be listed in the README as intentional omissions.

| Item | Why it waits |
| --- | --- |
| Operator manually assigns a specific contributor | Phase 1 relies on rerouting; manual assignment adds a third party to the race |
| Operator changes priority after creation | Priority is set once at creation in phase 1 |
| Operator cancels a task | Not in the brief; adds a terminal state and more races |
| Timers keep counting during downtime | Alternative to pausing (D12); a product choice to revisit |
| Smarter handling when nobody eligible exists | Phase 1 keeps rerouting (D3); later: slow the retries and show "No eligible contributor" |
| Multiple operators, login | One operator, no auth, in phase 1 |
