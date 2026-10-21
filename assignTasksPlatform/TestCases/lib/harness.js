'use strict';
// Starts the app as a child process with its own port, database, data and
// settings, and supports hard kills and restarts.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { APP_DIR, SERVER_ENTRY, HOST, SPEED } = require('./env');
const { Api } = require('./api');
const { writeFixtures } = require('./fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simMs = (s) => (s * 1000) / SPEED;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

class TestServer {
  constructor(opts = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-tests-'));
    this.paths = writeFixtures(this.dir, opts);
    this.proc = null;
    this.running = false;
    this.log = '';
    this.ids = {};
  }

  // Resolves once GET /api/state answers. With expectExit, resolves with the
  // exit { code, signal } instead (for boots that must fail).
  async start({ expectExit = false } = {}) {
    this.port = this.port || await freePort();
    this.api = new Api(`http://${HOST}:${this.port}`);
    const env = {
      ...process.env,
      PORT: String(this.port),
      DB_FILE: this.paths.dbFile,
      SETTINGS_FILE: this.paths.settingsFile,
      DATA_DIR: this.paths.dataDir,
    };
    const proc = spawn(process.execPath, [path.join(APP_DIR, SERVER_ENTRY)], {
      cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    this.proc = proc;
    this.running = true;
    proc.stdout.on('data', (d) => { this.log += d; });
    proc.stderr.on('data', (d) => { this.log += d; });
    this.exited = new Promise((resolve) => proc.once('exit', (code, signal) => {
      this.running = false;
      resolve({ code, signal });
    }));

    if (expectExit) {
      const timeout = sleep(15000).then(() => { throw new Error(`Server did not exit:\n${this.log}`); });
      return Promise.race([this.exited, timeout]);
    }

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!this.running) throw new Error(`Server exited during start:\n${this.log}`);
      try {
        const r = await this.api.state();
        if (r.status === 200) {
          this.readyAt = Date.now();
          await this.refreshIds();
          return this;
        }
      } catch { /* not listening yet */ }
      await sleep(50);
    }
    throw new Error(`Server did not start within 15 s:\n${this.log}`);
  }

  // Hard kill (TerminateProcess on Windows, SIGKILL elsewhere): no final heartbeat.
  async kill() {
    if (!this.running) return;
    const exited = this.exited;
    this.proc.kill('SIGKILL');
    await exited;
    this.killedAt = Date.now();
  }

  // Ctrl+C equivalent. Only meaningful off Windows, where SIGINT is delivered.
  async stopGracefully() {
    if (!this.running) return;
    const exited = this.exited;
    this.proc.kill('SIGINT');
    await exited;
    this.killedAt = Date.now();
  }

  // Kill, stay down for `downSim` simulated seconds, start again.
  // Returns the real downtime in simulated seconds (kill → ready).
  async restart(downSim) {
    await this.kill();
    await sleep(simMs(downSim));
    await this.start();
    return ((this.readyAt - this.killedAt) * SPEED) / 1000;
  }

  async reset() {
    const r = await this.api.reset();
    assert.ok(r.status < 300, `Reset failed: ${r.status} ${r.text}`);
    await this.refreshIds();
  }

  async refreshIds() {
    try {
      const r = await this.api.state();
      const list = (r.body && r.body.contributors) || [];
      this.ids = Object.fromEntries(list.map((c) => [c.name, c.id]));
    } catch { this.ids = {}; }
  }

  // Doc id (C-02) → the app's id for the fixture's second contributor.
  C(docId) {
    const n = Number(String(docId).replace(/\D/g, ''));
    const entry = this.paths.contributors[n - 1];
    assert.ok(entry, `fixture has no contributor ${docId}`);
    return this.ids[entry.name] || docId;
  }

  async cleanup() {
    await this.kill();
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* file still locked */ }
  }
}

// Runs fn with a fresh server built from opts and always cleans it up.
async function withServer(opts, fn) {
  const srv = new TestServer(opts);
  try {
    await srv.start();
    return await fn(srv);
  } finally {
    await srv.cleanup();
  }
}

module.exports = { TestServer, withServer, sleep, simMs };
