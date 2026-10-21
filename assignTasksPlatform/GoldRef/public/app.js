const ui = {
  view: 'operator',
  selectedTaskId: null,
  data: null,
  detail: null,
  work: null,
  flash: null,
  pollMs: 1000,
  contributorsKey: '',
};

const $ = (id) => document.getElementById(id);

// ---------- formatting (D36) ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDuration(seconds) {
  if (seconds == null) return '';
  if (seconds < 60) return `${Math.round(seconds * 10) / 10} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
const statusLabel = (s) => ({ in_progress: 'in progress', accepted: 'in progress' }[s] || s);
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function names() {
  const map = {};
  for (const c of ui.data?.contributors || []) map[c.id] = c.name;
  return map;
}

function describe(e) {
  const n = names();
  const who = (id) => n[id] || id;
  const d = e.details;
  const r = e.requestId;
  switch (e.type) {
    case 'task.created': return `Task created (keyword ${d.keyword}, priority ${d.priority})`;
    case 'routing.requested': return `Routing request ${r} sent (reason: ${d.reason}, ${d.eligibleCount} eligible)`;
    case 'routing.answered': return `${r} answered after ${fmtDuration(d.latencySeconds)}: ${who(d.contributorId)}`;
    case 'routing.no_match': return `${r} answered after ${fmtDuration(d.latencySeconds)}: no match`;
    case 'routing.overdue': return `${r} overdue: no answer after ${fmtDuration(d.deadlineSeconds)}`;
    case 'routing.stale_ignored': return `Late answer from ${r} ignored (current request is ${d.currentRequestId || 'none'})`;
    case 'routing.lost_on_restart': return `${r} lost when the server restarted`;
    case 'routing.pick_unavailable': return `${r} picked ${who(d.contributorId)}, who is busy on ${d.busyOnTaskId}; treated as no match`;
    case 'assignment.offered': return `Offered to ${who(d.contributorId)}; expires in ${fmtDuration(d.expiresInSeconds)}`;
    case 'assignment.accepted': return `Accepted by ${who(d.contributorId)}`;
    case 'assignment.declined': return `Declined by ${who(d.contributorId)}`;
    case 'assignment.expired': return `Offer to ${who(d.contributorId)} expired`;
    case 'assignment.removed': return `Operator removed ${who(d.contributorId)} (was: ${statusLabel(d.wasStatus)})`;
    case 'assignment.completed': return `Completed by ${who(d.contributorId)} after ${fmtDuration(d.workSeconds)}`;
    case 'operator.reroute_now': return `Operator clicked Reroute now${d.requestId ? ` (cancels ${d.requestId})` : ''}`;
    case 'action.rejected': {
      const by = d.attemptedBy === 'operator' ? 'operator' : who(d.attemptedBy);
      return `${capitalise(d.action)} by ${by} rejected: ${d.code}`;
    }
    case 'server.restarted': return `Server restarted after ${fmtDuration(d.downtimeSeconds)} down; timers extended by ${fmtDuration(d.downtimeSeconds)}`;
    default: return e.type;
  }
}

// ---------- API ----------

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    setOnline(false);
    throw err;
  }
  setOnline(true);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error?.message || res.statusText);
    err.code = json.error?.code;
    err.task = json.task;
    throw err;
  }
  return json;
}

function setOnline(online) {
  $('offline-banner').hidden = online;
}

function showFlash(message) {
  ui.flash = { message, until: Date.now() + 8000 };
}

async function refresh() {
  ui.data = await api('GET', '/api/state');
  ui.pollMs = ui.data.config.pollIntervalMs;
  if (ui.view === 'operator') {
    ui.detail = ui.selectedTaskId ? await api('GET', `/api/tasks/${ui.selectedTaskId}`).catch(() => null) : null;
  } else {
    try {
      ui.work = await api('GET', `/api/contributors/${ui.view}/work`);
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
      ui.view = 'operator'; // contributor no longer exists after a Reset
      ui.contributorsKey = '';
    }
  }
  render();
}

async function poll() {
  try {
    await refresh();
  } catch (err) {
    // offline banner already shown by api(); keep the last view on screen
  } finally {
    setTimeout(poll, ui.pollMs);
  }
}

async function act(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code) showFlash(err.message);
  }
  await refresh().catch(() => {});
}

// ---------- rendering ----------

function render() {
  renderViewSelect();
  $('operator-view').hidden = ui.view !== 'operator';
  $('contributor-view').hidden = ui.view === 'operator';
  if (ui.flash && Date.now() > ui.flash.until) ui.flash = null;
  if (ui.view === 'operator') renderOperator();
  else renderContributor();
}

function renderViewSelect() {
  const contributors = ui.data.contributors;
  const key = contributors.map((c) => c.id + c.name).join('|');
  if (key === ui.contributorsKey) return;
  ui.contributorsKey = key;
  const select = $('view-select');
  select.innerHTML = '<option value="operator">Operator</option>'
    + contributors.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.id)})</option>`).join('');
  select.value = ui.view;

  const kw = $('keyword-select');
  const current = kw.value;
  kw.innerHTML = ui.data.config.keywords.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  if (current) kw.value = current;
}

function routingCell(t) {
  if (t.status !== 'routing') return '';
  let text = t.currentRequestId
    ? `${esc(t.currentRequestId)} · ${fmtDuration(t.routingElapsedSeconds)}`
    : `rerouting in ${fmtDuration(t.nextRoutingInSeconds)}`;
  if (t.overdue) text += ` <span class="badge-overdue">Overdue · no answer for ${fmtDuration(t.routingElapsedSeconds)}</span>`;
  return text;
}

function assigneeCell(t) {
  const a = t.assignee;
  if (!a) return '<span class="muted">—</span>';
  if (a.status === 'offered') return `${esc(a.name)} <span class="muted">offer ${fmtDuration(a.offerExpiresInSeconds)} left</span>`;
  return `${esc(a.name)} <span class="muted">${fmtDuration(a.workSeconds)}</span>`;
}

function renderOperator() {
  $('task-rows').innerHTML = ui.data.tasks.map((t) => `
    <tr data-task="${esc(t.id)}" class="${t.id === ui.selectedTaskId ? 'selected' : ''}">
      <td>${esc(t.id)}</td>
      <td class="title">${esc(t.title)}</td>
      <td>${esc(t.keyword)}</td>
      <td>${esc(t.priority)}</td>
      <td><span class="status ${esc(t.status)}">${esc(statusLabel(t.status))}</span></td>
      <td>${fmtDuration(t.ageSeconds)}</td>
      <td>${routingCell(t)}</td>
      <td>${assigneeCell(t)}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="muted">No tasks yet.</td></tr>';

  $('contributor-list').innerHTML = ui.data.contributors.map((c) => `
    <li>
      <strong>${esc(c.name)}</strong> <span class="muted">${esc(c.id)}</span>
      <div class="kw">${c.keywords.map(esc).join(', ')}</div>
      <div>${c.currentTaskId
        ? `${esc(statusLabel(c.currentStatus))} on ${esc(c.currentTaskId)}`
        : '<span class="muted">free</span>'}</div>
    </li>`).join('');

  renderDetail();
}

function renderDetail() {
  const panel = $('detail-panel');
  const t = ui.detail;
  if (!t) {
    panel.innerHTML = '<p class="muted">Select a task to see its history and actions.</p>';
    return;
  }
  const a = t.assignee;
  const actions = [];
  if (t.status === 'routing') actions.push('<button data-op="reroute">Reroute now</button>');
  if (a && (a.status === 'offered' || a.status === 'accepted')) {
    actions.push('<button class="danger" data-op="remove">Remove contributor</button>');
  }
  panel.innerHTML = `
    <h2>${esc(t.id)} · ${esc(t.title)}</h2>
    ${ui.flash ? `<div class="flash">${esc(ui.flash.message)}</div>` : ''}
    <dl class="fields">
      <dt>State</dt><dd><span class="status ${esc(t.status)}">${esc(statusLabel(t.status))}</span>
        ${t.overdue ? `<span class="badge-overdue">Overdue · no answer for ${fmtDuration(t.routingElapsedSeconds)}</span>` : ''}</dd>
      <dt>Keyword</dt><dd>${esc(t.keyword)}</dd>
      <dt>Priority</dt><dd>${esc(t.priority)}</dd>
      <dt>Age</dt><dd>${fmtDuration(t.ageSeconds)}</dd>
      <dt>Requests</dt><dd>${t.requestCount}${t.currentRequestId ? ` (current ${esc(t.currentRequestId)})` : ''}</dd>
      <dt>Assignee</dt><dd>${assigneeCell(t)}</dd>
      ${t.disclaimers ? `<dt>Disclaimers</dt><dd>${esc(t.disclaimers)}</dd>` : ''}
    </dl>
    <div class="actions">${actions.join('')}</div>
    <h2>History</h2>
    <ol class="timeline">
      ${t.history.map((e) => `
        <li><span>${fmtTime(e.at)}</span><span class="actor">${esc(e.actor)}</span><span>${esc(describe(e))}</span></li>`).join('')}
    </ol>`;
}

function renderContributor() {
  const panel = $('contributor-panel');
  const { contributor, task, recent } = ui.work;
  const flash = ui.flash ? `<div class="flash">${esc(ui.flash.message)}</div>` : '';
  const a = task && task.assignee;

  if (!a) {
    panel.innerHTML = `<h2>${esc(contributor.name)}</h2>${flash}
      <p class="muted">No offers right now. When the engine picks you for a task, the offer appears here.</p>`;
  } else {
    const details = `
      <dl class="fields">
        <dt>Task</dt><dd>${esc(task.id)} · ${esc(task.title)}</dd>
        <dt>Keyword</dt><dd>${esc(task.keyword)}</dd>
        <dt>Priority</dt><dd>${esc(task.priority)}</dd>
        <dt>Estimated effort</dt><dd>${esc(task.estimatedEffort) || '<span class="muted">not given</span>'}</dd>
      </dl>
      <p>${esc(task.description)}</p>
      ${task.disclaimers ? `<div class="disclaimer"><strong>Disclaimer:</strong> ${esc(task.disclaimers)}</div>` : ''}`;
    if (a.status === 'offered') {
      panel.innerHTML = `<h2>New offer for ${esc(contributor.name)}</h2>${flash}${details}
        <div class="clock">Offer expires in ${fmtDuration(a.offerExpiresInSeconds)}</div>
        <div class="actions">
          <button data-c="accept" data-assignment="${esc(a.assignmentId)}">Accept</button>
          <button class="secondary" data-c="decline" data-assignment="${esc(a.assignmentId)}">Decline</button>
        </div>`;
    } else {
      panel.innerHTML = `<h2>Working: ${esc(task.title)}</h2>${flash}${details}
        <div class="clock">In progress · ${fmtDuration(a.workSeconds)}</div>
        <div class="actions">
          <button data-c="complete" data-assignment="${esc(a.assignmentId)}">Complete</button>
        </div>`;
    }
  }

  $('recent-list').innerHTML = recent.map((r) => `
    <li>${esc(r.taskId)} · ${esc(r.title)} — <span class="status">${esc(r.status)}</span>
      <span class="muted">${r.endedAt ? fmtTime(r.endedAt) : ''}</span></li>`).join('')
    || '<li class="muted">Nothing yet.</li>';
}

// ---------- events ----------

$('view-select').addEventListener('change', (e) => {
  ui.view = e.target.value;
  ui.flash = null;
  refresh().catch(() => {});
});

$('task-rows').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-task]');
  if (!row) return;
  ui.selectedTaskId = row.dataset.task;
  ui.flash = null;
  refresh().catch(() => {});
});

function removePrompt(task) {
  const a = task.assignee;
  return a.status === 'accepted'
    ? `${a.name} is working on this. Remove them and reroute?`
    : `Revoke the offer to ${a.name} and reroute?`;
}

// If the task moved between loading and clicking (for example the contributor just
// accepted), ask again with the fresh state; the removal applies after confirmation.
async function removeContributor(task) {
  if (!confirm(removePrompt(task))) return;
  try {
    await api('POST', `/api/tasks/${task.id}/remove`, { version: task.version });
  } catch (err) {
    const fresh = err.task;
    if (err.code === 'STATE_CHANGED' && fresh && fresh.assignee
        && (fresh.assignee.status === 'offered' || fresh.assignee.status === 'accepted')) {
      await removeContributor(fresh);
      return;
    }
    throw err;
  }
}

$('detail-panel').addEventListener('click', (e) => {
  const op = e.target.dataset.op;
  if (!op || !ui.detail) return;
  const task = ui.detail;
  e.target.disabled = true;
  act(async () => {
    ui.flash = null;
    if (op === 'reroute') await api('POST', `/api/tasks/${task.id}/reroute`, { version: task.version });
    if (op === 'remove') await removeContributor(task);
  });
});

$('contributor-panel').addEventListener('click', (e) => {
  const action = e.target.dataset.c;
  if (!action) return;
  e.target.disabled = true;
  act(async () => {
    ui.flash = null;
    await api('POST', `/api/assignments/${e.target.dataset.assignment}/${action}`, { contributorId: ui.view });
  });
});

$('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form).entries());
  const msg = $('create-message');
  act(async () => {
    try {
      const task = await api('POST', '/api/tasks', body);
      msg.className = 'message ok';
      msg.textContent = `${task.id} created and routing.`;
      form.reset();
      ui.selectedTaskId = task.id;
    } catch (err) {
      msg.className = 'message';
      msg.textContent = err.message;
    }
  });
});

$('reset-btn').addEventListener('click', () => {
  if (!confirm('Reset wipes all tasks and history and reloads the seed data. Continue?')) return;
  act(async () => {
    try {
      await api('POST', '/api/reset');
      ui.selectedTaskId = null;
    } catch (err) {
      if (err.code) alert(`${err.message}\n\nNothing was reset.`);
      else throw err;
    }
  });
});

poll();
