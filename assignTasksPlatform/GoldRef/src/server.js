const path = require('path');
const express = require('express');
const { root, settings, loadData } = require('./config');
const { openDb } = require('./db');
const { createClock } = require('./clock');
const { createEngine } = require('./engine');
const { createService } = require('./service');
const { AppError } = require('./errors');

const clock = createClock(settings.sim.speed_multiplier);
const db = openDb(path.resolve(root, settings.db.path));
let service;
const engine = createEngine({
  settings,
  clock,
  onAnswer: (answer) => {
    try {
      service.handleAnswer(answer);
    } catch (err) {
      console.error(err);
    }
  },
});
service = createService({ db, settings, clock, engine, loadData });

const app = express();
app.use(express.json());
app.use(express.static(path.join(root, 'public')));

const handle = (fn) => (req, res, next) => {
  try {
    res.json(fn(req));
  } catch (err) {
    next(err);
  }
};

const versionOf = (body) => (body && body.version != null ? Number(body.version) : null);

app.get('/api/state', handle(() => service.state()));
app.get('/api/tasks', handle(() => service.listTasks()));
app.get('/api/tasks/:id', handle((req) => service.taskDetail(req.params.id)));
app.post('/api/tasks', handle((req) => service.createTask(req.body)));
app.post('/api/tasks/:id/reroute', handle((req) => service.rerouteNow(req.params.id, versionOf(req.body))));
app.post('/api/tasks/:id/remove', handle((req) => service.removeContributor(req.params.id, versionOf(req.body))));

for (const action of ['accept', 'decline', 'complete']) {
  app.post(`/api/assignments/:id/${action}`, handle((req) =>
    service.contributorAction(req.params.id, req.body && req.body.contributorId, action)));
}

app.get('/api/contributors/:id/work', handle((req) => service.contributorWork(req.params.id)));
app.post('/api/reset', handle(() => service.reset()));
app.post('/api/sim/script', handle((req) => service.scriptEngine(req.body && req.body.taskId, req.body && req.body.answers)));

app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message },
      task: err.taskId ? service.taskById(err.taskId) : null,
    });
    return;
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'request body must be valid JSON' }, task: null });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' }, task: null });
});

service.boot();
const ticker = setInterval(() => {
  try {
    service.tick();
  } catch (err) {
    console.error(err);
  }
}, settings.sim.tick_ms);

const server = app.listen(settings.server.port, () => {
  console.log(`Task routing running on http://localhost:${settings.server.port}`);
});

function shutdown() {
  clearInterval(ticker);
  service.heartbeat();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
