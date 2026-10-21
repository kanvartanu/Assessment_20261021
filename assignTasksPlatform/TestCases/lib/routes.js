'use strict';
// HTTP routes the suite calls. The doc fixes some of these (GET /api/tasks,
// /api/tasks/:id, /api/state, /api/contributors/:id/work, POST /api/sim/script).
// The action routes are assumptions (see "Assumptions the test suite makes" in
// the doc). If the app uses other paths, change them here only.
module.exports = {
  state: () => ['GET', '/api/state'],
  listTasks: () => ['GET', '/api/tasks'],
  getTask: (id) => ['GET', `/api/tasks/${id}`],
  createTask: () => ['POST', '/api/tasks'],
  rerouteNow: (taskId) => ['POST', `/api/tasks/${taskId}/reroute`],
  removeContributor: (taskId) => ['POST', `/api/tasks/${taskId}/remove`],
  accept: (assignmentId) => ['POST', `/api/assignments/${assignmentId}/accept`],
  decline: (assignmentId) => ['POST', `/api/assignments/${assignmentId}/decline`],
  complete: (assignmentId) => ['POST', `/api/assignments/${assignmentId}/complete`],
  contributorWork: (contributorId) => ['GET', `/api/contributors/${contributorId}/work`],
  reset: () => ['POST', '/api/reset'],
  simScript: () => ['POST', '/api/sim/script'],
};
