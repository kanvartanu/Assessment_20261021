const { hasSchema, resetSchema, transaction, afterCommit } = require('./db');
const { AppError } = require('./errors');

const PRIORITIES = ['low', 'normal', 'high'];

const pad = (n, width) => String(n).padStart(width, '0');
const round1 = (x) => Math.round(x * 10) / 10;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function createService({ db, settings, clock, engine, loadData }) {
  // Bumped on Reset; engine answers carrying an older generation are dropped (D42).
  let generation = 0;
  let areas = [];
  let lastHeartbeat = 0;

  const tx = (fn) => transaction(db, fn);
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);

  const getTask = (id) => one('SELECT * FROM tasks WHERE id = ?', id);
  const getContributor = (id) => one('SELECT * FROM contributors WHERE id = ?', id);
  const getAssignment = (id) => one('SELECT * FROM assignments WHERE id = ?', id);
  const activeAssignment = (taskId) =>
    one("SELECT * FROM assignments WHERE task_id = ? AND status IN ('offered', 'accepted')", taskId);

  function nextSeq(table) {
    return (one(`SELECT MAX(seq) AS m FROM ${table}`).m || 0) + 1;
  }

  function logEvent(taskId, actor, type, details = {}, { requestId = null, assignmentId = null } = {}) {
    run(
      'INSERT INTO events (task_id, assignment_id, request_id, actor, type, details, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      taskId, assignmentId, requestId, actor, type, JSON.stringify(details), clock.now(),
    );
  }

  // Compare-and-set: the write only lands if nobody moved the task since we read it.
  function updateTask(task, fields) {
    const cols = Object.keys(fields);
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    const res = run(
      `UPDATE tasks SET ${sets}, version = version + 1 WHERE id = ? AND version = ? AND status = ?`,
      ...cols.map((c) => fields[c]), task.id, task.version, task.status,
    );
    if (res.changes === 0) throw new AppError('STATE_CHANGED', { taskId: task.id });
    return getTask(task.id);
  }

  // Logs the rejection and returns the error; guarded() throws it after commit so
  // the action.rejected event survives.
  function rejection(task, attemptedBy, action, code, assignmentId = null) {
    logEvent(task.id, 'system', 'action.rejected', { attemptedBy, action, code }, { assignmentId });
    return new AppError(code, { taskId: task.id });
  }

  function guarded(fn) {
    const result = tx(fn);
    if (result instanceof AppError) throw result;
    return result;
  }

  // ---------- routing ----------

  // Eligible = has the keyword and is free (D7, D35). Contributors who declined or
  // let an offer expire are skipped until every keyword holder has done so, then
  // the cycle starts over (D31).
  function eligibleFor(task) {
    const holders = all('SELECT * FROM contributors ORDER BY id')
      .filter((c) => JSON.parse(c.keywords).includes(task.keyword));
    const excluded = new Set(all(
      "SELECT DISTINCT contributor_id FROM assignments WHERE task_id = ? AND status IN ('declined', 'expired') AND seq > ?",
      task.id, task.exclusion_floor,
    ).map((r) => r.contributor_id));
    let floor = task.exclusion_floor;
    if (holders.length > 0 && holders.every((c) => excluded.has(c.id))) {
      floor = nextSeq('assignments') - 1;
      excluded.clear();
    }
    const ids = holders.filter((c) => c.current_assignment_id === null && !excluded.has(c.id)).map((c) => c.id);
    return { ids, floor };
  }

  function sendRequest(task, reason) {
    const { ids, floor } = eligibleFor(task);
    const count = task.request_count + 1;
    const requestId = `R-${pad(task.seq, 3)}-${count}`;
    const now = clock.now();
    const updated = updateTask(task, {
      status: 'routing',
      current_request_id: requestId,
      request_count: count,
      routing_started_at: task.status === 'routing' ? task.routing_started_at : now,
      routing_deadline_at: now + clock.ms(settings.routing.deadline_s[task.priority]),
      next_routing_at: null,
      next_routing_reason: null,
      overdue: reason === 'retry_deadline' ? 1 : 0,
      exclusion_floor: floor,
    });
    logEvent(task.id, 'system', 'routing.requested', { reason, eligibleCount: ids.length }, { requestId });
    const gen = generation;
    afterCommit(() => engine.request({ generation: gen, taskId: task.id, requestId, eligibleIds: ids }));
    return updated;
  }

  // Back to Routing with the 5 s pause (D30); the ticker sends the request.
  function scheduleReroute(task, reason) {
    const now = clock.now();
    return updateTask(task, {
      status: 'routing',
      current_request_id: null,
      routing_started_at: task.status === 'routing' ? task.routing_started_at : now,
      routing_deadline_at: null,
      next_routing_at: now + clock.ms(settings.routing.reroute_delay_s),
      next_routing_reason: reason,
      overdue: 0,
    });
  }

  function endAssignment(assignment, status, reason) {
    run(
      'UPDATE assignments SET status = ?, ended_at = ?, reason = ? WHERE id = ? AND status = ?',
      status, clock.now(), reason, assignment.id, assignment.status,
    );
    run(
      'UPDATE contributors SET current_assignment_id = NULL WHERE id = ? AND current_assignment_id = ?',
      assignment.contributor_id, assignment.id,
    );
  }

  function createOffer(task, contributorId, requestId) {
    const seq = nextSeq('assignments');
    const id = `A-${pad(seq, 3)}`;
    const now = clock.now();
    run(
      `INSERT INTO assignments (id, seq, task_id, contributor_id, status, offered_at, offer_expires_at)
       VALUES (?, ?, ?, ?, 'offered', ?, ?)`,
      id, seq, task.id, contributorId, now, now + clock.ms(settings.offer.expiry_s),
    );
    run('UPDATE contributors SET current_assignment_id = ? WHERE id = ? AND current_assignment_id IS NULL', id, contributorId);
    updateTask(task, { status: 'offered', current_request_id: null, routing_deadline_at: null, overdue: 0 });
    logEvent(task.id, 'system', 'assignment.offered',
      { contributorId, expiresInSeconds: settings.offer.expiry_s }, { assignmentId: id, requestId });
  }

  function handleAnswer({ generation: gen, taskId, requestId, contributorId, latencySeconds }) {
    if (gen !== generation) return;
    tx(() => {
      const task = getTask(taskId);
      if (!task) return;
      const latency = round1(latencySeconds);
      if (task.current_request_id !== requestId) {
        logEvent(taskId, 'engine', 'routing.stale_ignored',
          { currentRequestId: task.current_request_id, outcome: contributorId ?? 'no_match' }, { requestId });
        return;
      }
      if (!contributorId) {
        logEvent(taskId, 'engine', 'routing.no_match', { latencySeconds: latency }, { requestId });
        scheduleReroute(task, 'no_match');
        return;
      }
      logEvent(taskId, 'engine', 'routing.answered', { contributorId, latencySeconds: latency }, { requestId });
      const contributor = getContributor(contributorId);
      if (!contributor || contributor.current_assignment_id) {
        const busy = contributor && getAssignment(contributor.current_assignment_id);
        logEvent(taskId, 'system', 'routing.pick_unavailable',
          { contributorId, busyOnTaskId: busy ? busy.task_id : null }, { requestId });
        scheduleReroute(task, 'no_match');
        return;
      }
      createOffer(task, contributorId, requestId);
    });
  }

  // ---------- timers ----------

  function safely(fn) {
    try { fn(); } catch (err) { console.error(err); }
  }

  // Timers are derived from stored timestamps (D10), so this can run at any rate
  // and is also called before every action to bring state up to date.
  function tick() {
    const now = clock.now();

    for (const task of all(
      "SELECT * FROM tasks WHERE status = 'routing' AND current_request_id IS NOT NULL AND routing_deadline_at <= ?", now,
    )) {
      safely(() => tx(() => {
        logEvent(task.id, 'system', 'routing.overdue',
          { deadlineSeconds: settings.routing.deadline_s[task.priority] }, { requestId: task.current_request_id });
        sendRequest(task, 'retry_deadline');
      }));
    }

    for (const task of all(
      "SELECT * FROM tasks WHERE status = 'routing' AND current_request_id IS NULL AND next_routing_at <= ?", now,
    )) {
      safely(() => tx(() => sendRequest(task, task.next_routing_reason || 'no_match')));
    }

    for (const a of all("SELECT * FROM assignments WHERE status = 'offered' AND offer_expires_at <= ?", now)) {
      safely(() => tx(() => {
        endAssignment(a, 'expired', 'offer expired');
        logEvent(a.task_id, 'system', 'assignment.expired', { contributorId: a.contributor_id }, { assignmentId: a.id });
        scheduleReroute(getTask(a.task_id), 'expired');
      }));
    }

    if (now - lastHeartbeat >= clock.ms(settings.heartbeat.interval_s)) heartbeat();
  }

  function heartbeat() {
    lastHeartbeat = clock.now();
    run('UPDATE meta SET last_alive_at = ? WHERE id = 1', lastHeartbeat);
  }

  // Restart (D12, D39): push every open clock later by the downtime so timers pause,
  // and resend routing requests the in-memory engine lost.
  function recoverFromRestart() {
    const meta = one('SELECT last_alive_at FROM meta WHERE id = 1');
    if (!meta || meta.last_alive_at == null) return;
    const downtime = Math.max(0, clock.now() - meta.last_alive_at);
    const downtimeSeconds = round1(clock.seconds(downtime));
    tx(() => {
      run("UPDATE assignments SET offer_expires_at = offer_expires_at + ? WHERE status = 'offered'", downtime);
      run("UPDATE assignments SET paused_ms = paused_ms + ? WHERE status = 'accepted'", downtime);
      for (const task of all("SELECT * FROM tasks WHERE status != 'completed' ORDER BY seq")) {
        logEvent(task.id, 'system', 'server.restarted', { downtimeSeconds });
        if (task.status !== 'routing') continue;
        const shifted = updateTask(task, {
          routing_started_at: task.routing_started_at == null ? null : task.routing_started_at + downtime,
          next_routing_at: task.next_routing_at == null ? null : task.next_routing_at + downtime,
        });
        if (shifted.current_request_id) {
          logEvent(task.id, 'system', 'routing.lost_on_restart', { downtimeSeconds }, { requestId: shifted.current_request_id });
          sendRequest(shifted, 'restart');
        }
      }
    });
  }

  // ---------- seed / reset ----------

  function insertTask(input, actor) {
    const error = validateTask(input);
    if (error) throw new AppError('VALIDATION_FAILED', { message: error });
    const seq = nextSeq('tasks');
    const id = `T-${pad(seq, 3)}`;
    run(
      `INSERT INTO tasks (id, seq, title, description, keyword, priority, disclaimers, estimated_effort, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?)`,
      id, seq, input.title.trim(), input.description || '', input.keyword, input.priority,
      input.disclaimers || '', input.estimatedEffort || '', clock.now(),
    );
    logEvent(id, actor, 'task.created', { keyword: input.keyword, priority: input.priority });
    sendRequest(getTask(id), 'submit'); // creating submits (D32)
    return id;
  }

  // Everything is checked before the database is wiped, so a bad seed file leaves
  // the current state untouched.
  function readSeed() {
    let data;
    try {
      data = loadData();
    } catch (err) {
      throw new AppError('VALIDATION_FAILED', { message: `Seed data invalid: ${err.message}` });
    }
    const error = validateSeed(data);
    if (error) throw new AppError('VALIDATION_FAILED', { message: `Seed data invalid: ${error}` });
    return data;
  }

  function seed() {
    const data = readSeed();
    generation += 1;
    engine.reset();
    resetSchema(db);
    areas = data.areas;
    for (const s of data.scenarios) engine.script(s.taskId, s.engine);
    tx(() => {
      data.contributors.forEach((c, i) => {
        run('INSERT INTO contributors (id, name, keywords) VALUES (?, ?, ?)',
          c.id || `C-${pad(i + 1, 2)}`, c.name, JSON.stringify(c.keywords));
      });
      for (const t of data.tasks) insertTask(t, 'system');
    });
    heartbeat();
  }

  function boot() {
    if (!hasSchema(db)) {
      seed();
      return;
    }
    areas = readSeed().areas;
    recoverFromRestart();
    heartbeat();
  }

  // ---------- validation ----------

  function validateSeed({ areas: seedAreas, contributors, tasks, scenarios }) {
    if (!Array.isArray(seedAreas) || !seedAreas.length || !seedAreas.every((a) => typeof a === 'string' && a)) {
      return 'expertise-areas.json must be a non-empty list of names';
    }
    if (!Array.isArray(contributors)) return 'contributors.json must be a list';
    const ids = new Set();
    for (const [i, c] of contributors.entries()) {
      const where = `contributors.json entry ${i + 1}`;
      if (!c || typeof c.name !== 'string' || !c.name.trim()) return `${where}: name is required`;
      if (!Array.isArray(c.keywords) || !c.keywords.length) return `${where} (${c.name}): keywords must be a non-empty list`;
      const bad = c.keywords.find((k) => !seedAreas.includes(k));
      if (bad !== undefined) return `${where} (${c.name}): unknown keyword "${bad}"`;
      const id = c.id || `C-${pad(i + 1, 2)}`;
      if (ids.has(id)) return `${where} (${c.name}): duplicate id ${id}`;
      ids.add(id);
    }
    if (!Array.isArray(tasks)) return 'tasks.json must be a list';
    for (const [i, t] of tasks.entries()) {
      const error = validateTask(t, seedAreas);
      if (error) return `tasks.json entry ${i + 1}: ${error}`;
    }
    if (!Array.isArray(scenarios)) return 'scenarios.json must be a list';
    for (const [i, s] of scenarios.entries()) {
      if (!s || typeof s.taskId !== 'string' || !Array.isArray(s.engine)) {
        return `scenarios.json entry ${i + 1}: taskId and an engine list are required`;
      }
    }
    return null;
  }

  function validateTask(input, allowedAreas = areas) {
    if (!input || typeof input !== 'object') return 'request body must be a JSON object';
    if (typeof input.title !== 'string' || !input.title.trim()) return 'title is required';
    if (!allowedAreas.includes(input.keyword)) return `keyword must be one of: ${allowedAreas.join(', ')}`;
    if (!PRIORITIES.includes(input.priority)) return `priority must be one of: ${PRIORITIES.join(', ')}`;
    for (const field of ['description', 'disclaimers', 'estimatedEffort']) {
      if (input[field] != null && typeof input[field] !== 'string') return `${field} must be text`;
    }
    return null;
  }

  function requireTask(taskId) {
    const task = getTask(taskId);
    if (!task) throw new AppError('NOT_FOUND');
    return task;
  }

  // ---------- operator actions ----------

  function createTask(input) {
    tick();
    const id = tx(() => insertTask(input, 'operator'));
    return taskJson(getTask(id));
  }

  function rerouteNow(taskId, version) {
    tick();
    return guarded(() => {
      const task = requireTask(taskId);
      if (task.status !== 'routing') return rejection(task, 'operator', 'reroute', 'NOT_ROUTING');
      if (version != null && version !== task.version) return rejection(task, 'operator', 'reroute', 'STATE_CHANGED');
      logEvent(task.id, 'operator', 'operator.reroute_now',
        { requestId: task.current_request_id }, { requestId: task.current_request_id });
      return taskJson(sendRequest(task, 'operator_reroute'));
    });
  }

  function removeContributor(taskId, version) {
    tick();
    return guarded(() => {
      const task = requireTask(taskId);
      if (task.status === 'completed') return rejection(task, 'operator', 'remove', 'ALREADY_COMPLETED');
      if (version != null && version !== task.version) return rejection(task, 'operator', 'remove', 'STATE_CHANGED');
      const a = activeAssignment(task.id);
      if (!a) return rejection(task, 'operator', 'remove', 'STATE_CHANGED');
      endAssignment(a, 'removed', 'removed by operator');
      logEvent(task.id, 'operator', 'assignment.removed',
        { contributorId: a.contributor_id, wasStatus: a.status === 'accepted' ? 'in_progress' : 'offered' },
        { assignmentId: a.id });
      return taskJson(scheduleReroute(task, 'removed'));
    });
  }

  // ---------- contributor actions ----------

  function contributorRejection(a, contributorId, action) {
    if (a.contributor_id !== contributorId) return 'NOT_YOUR_OFFER';
    if (action === 'complete') {
      if (a.status === 'accepted') return null;
      if (a.status === 'removed') return 'REMOVED_FROM_ASSIGNMENT';
      if (a.status === 'declined' || a.status === 'expired') return 'OFFER_NO_LONGER_AVAILABLE';
      return 'STATE_CHANGED';
    }
    if (a.status === 'offered') return null;
    if (a.status === 'accepted' || a.status === 'completed') return 'STATE_CHANGED';
    return 'OFFER_NO_LONGER_AVAILABLE';
  }

  function contributorAction(assignmentId, contributorId, action) {
    if (typeof contributorId !== 'string' || !contributorId) {
      throw new AppError('VALIDATION_FAILED', { message: 'contributorId is required' });
    }
    tick();
    return guarded(() => {
      const a = getAssignment(assignmentId);
      if (!a) throw new AppError('NOT_FOUND', { message: 'Assignment not found.' });
      const task = getTask(a.task_id);
      const code = contributorRejection(a, contributorId, action);
      if (code) return rejection(task, contributorId, action, code, a.id);
      const now = clock.now();
      const ids = { assignmentId: a.id };
      if (action === 'accept') {
        run("UPDATE assignments SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'offered'", now, a.id);
        updateTask(task, { status: 'in_progress' });
        logEvent(task.id, 'contributor', 'assignment.accepted', { contributorId }, ids);
      } else if (action === 'decline') {
        endAssignment(a, 'declined', 'declined by contributor');
        logEvent(task.id, 'contributor', 'assignment.declined', { contributorId }, ids);
        scheduleReroute(task, 'declined');
      } else {
        const workSeconds = Math.round(clock.seconds(now - a.accepted_at - a.paused_ms));
        endAssignment(a, 'completed', 'completed by contributor');
        updateTask(task, { status: 'completed', overdue: 0 });
        logEvent(task.id, 'contributor', 'assignment.completed', { contributorId, workSeconds }, ids);
      }
      return taskJson(getTask(task.id));
    });
  }

  // ---------- read models ----------

  function assigneeJson(task, now) {
    const a = task.status === 'completed'
      ? one("SELECT * FROM assignments WHERE task_id = ? AND status = 'completed'", task.id)
      : activeAssignment(task.id);
    if (!a) return null;
    const c = getContributor(a.contributor_id);
    let workSeconds = null;
    if (a.status === 'accepted') workSeconds = Math.floor(clock.seconds(now - a.accepted_at - a.paused_ms));
    if (a.status === 'completed') workSeconds = Math.round(clock.seconds(a.ended_at - a.accepted_at - a.paused_ms));
    return {
      assignmentId: a.id,
      contributorId: c.id,
      name: c.name,
      status: a.status,
      offerExpiresInSeconds: a.status === 'offered'
        ? Math.max(0, Math.ceil(clock.seconds(a.offer_expires_at - now))) : null,
      workSeconds,
    };
  }

  function taskJson(task, now = clock.now()) {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      keyword: task.keyword,
      priority: task.priority,
      disclaimers: task.disclaimers,
      estimatedEffort: task.estimated_effort,
      status: task.status,
      createdAt: iso(task.created_at),
      ageSeconds: Math.floor(clock.seconds(now - task.created_at)),
      overdue: task.overdue === 1,
      currentRequestId: task.current_request_id,
      requestCount: task.request_count,
      routingElapsedSeconds: task.status === 'routing' && task.routing_started_at != null
        ? Math.floor(clock.seconds(now - task.routing_started_at)) : null,
      nextRoutingInSeconds: task.status === 'routing' && task.next_routing_at != null
        ? Math.max(0, Math.ceil(clock.seconds(task.next_routing_at - now))) : null,
      assignee: assigneeJson(task, now),
      version: task.version,
    };
  }

  function eventJson(e) {
    return {
      id: e.id,
      taskId: e.task_id,
      at: iso(e.at),
      actor: e.actor,
      type: e.type,
      requestId: e.request_id,
      assignmentId: e.assignment_id,
      details: JSON.parse(e.details),
    };
  }

  function contributorJson(c) {
    const a = c.current_assignment_id ? getAssignment(c.current_assignment_id) : null;
    return {
      id: c.id,
      name: c.name,
      keywords: JSON.parse(c.keywords),
      currentAssignmentId: c.current_assignment_id,
      currentTaskId: a ? a.task_id : null,
      currentStatus: a ? a.status : null,
    };
  }

  function listTasks() {
    const now = clock.now();
    return all('SELECT * FROM tasks ORDER BY seq DESC').map((t) => taskJson(t, now));
  }

  function taskDetail(taskId) {
    const task = requireTask(taskId);
    return {
      ...taskJson(task),
      history: all('SELECT * FROM events WHERE task_id = ? ORDER BY id', taskId).map(eventJson),
    };
  }

  function taskById(taskId) {
    const task = getTask(taskId);
    return task ? taskJson(task) : null;
  }

  function state() {
    return {
      serverTime: iso(clock.now()),
      config: {
        keywords: areas,
        priorities: PRIORITIES,
        pollIntervalMs: settings.ui.poll_interval_ms,
      },
      tasks: listTasks(),
      contributors: all('SELECT * FROM contributors ORDER BY id').map(contributorJson),
    };
  }

  // A contributor sees only their own offer or work (C5).
  function contributorWork(contributorId) {
    const c = getContributor(contributorId);
    if (!c) throw new AppError('NOT_FOUND', { message: 'Contributor not found.' });
    const a = c.current_assignment_id ? getAssignment(c.current_assignment_id) : null;
    const recent = all(
      `SELECT a.id, a.task_id, a.status, a.ended_at, t.title FROM assignments a JOIN tasks t ON t.id = a.task_id
       WHERE a.contributor_id = ? AND a.status NOT IN ('offered', 'accepted') ORDER BY a.seq DESC LIMIT 5`,
      contributorId,
    ).map((r) => ({ assignmentId: r.id, taskId: r.task_id, title: r.title, status: r.status, endedAt: iso(r.ended_at) }));
    return { contributor: contributorJson(c), task: a ? taskJson(getTask(a.task_id)) : null, recent };
  }

  function reset() {
    seed();
    return state();
  }

  function scriptEngine(taskId, answers) {
    if (typeof taskId !== 'string' || !Array.isArray(answers)) {
      throw new AppError('VALIDATION_FAILED', { message: 'taskId and answers are required' });
    }
    engine.script(taskId, answers);
    return { taskId, answers };
  }

  return {
    boot, tick, heartbeat, handleAnswer,
    createTask, rerouteNow, removeContributor, contributorAction,
    state, listTasks, taskDetail, taskById, contributorWork, reset, scriptEngine,
  };
}

module.exports = { createService };
