'use strict';
const routes = require('./routes');

class Api {
  constructor(baseUrl) {
    this.base = baseUrl;
  }

  // Returns { status, body (parsed JSON or null), text, headers }. Never throws on HTTP errors.
  async request(method, url, body, { raw, contentType = 'application/json' } = {}) {
    const init = { method, headers: {} };
    if (raw !== undefined) {
      init.headers['content-type'] = contentType;
      init.body = raw;
    } else if (body !== undefined) {
      init.headers['content-type'] = contentType;
      init.body = JSON.stringify(body);
    }
    const res = await fetch(this.base + url, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  call(name, args, body, opts) {
    const [method, url] = routes[name](...args);
    return this.request(method, url, body, opts);
  }

  state() { return this.call('state', []); }
  listTasks() { return this.call('listTasks', []); }
  getTask(id) { return this.call('getTask', [id]); }
  createTask(fields, opts) { return this.call('createTask', [], fields, opts); }
  script(taskId, answers) { return this.call('simScript', [], { taskId, answers }); }
  reset() { return this.call('reset', []); }
  work(contributorId) { return this.call('contributorWork', [contributorId]); }

  rerouteNow(taskId, version) {
    return this.call('rerouteNow', [taskId], version === undefined ? {} : { version });
  }
  removeContributor(taskId, version) {
    return this.call('removeContributor', [taskId], version === undefined ? {} : { version });
  }
  accept(assignmentId, contributorId) { return this.call('accept', [assignmentId], { contributorId }); }
  decline(assignmentId, contributorId) { return this.call('decline', [assignmentId], { contributorId }); }
  complete(assignmentId, contributorId) { return this.call('complete', [assignmentId], { contributorId }); }
}

module.exports = { Api };
