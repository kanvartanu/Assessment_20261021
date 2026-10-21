const ERRORS = {
  OFFER_NO_LONGER_AVAILABLE: [409, 'This offer is no longer available.'],
  ALREADY_COMPLETED: [409, 'This task is already completed.'],
  REMOVED_FROM_ASSIGNMENT: [409, "You were removed from this assignment; your submission wasn't recorded."],
  STATE_CHANGED: [409, 'This task changed while you were looking at it. The view has been refreshed.'],
  VALIDATION_FAILED: [400, 'Validation failed.'],
  NOT_FOUND: [404, 'Task not found.'],
  NOT_ROUTING: [409, "This task isn't routing right now. Use Remove contributor instead."],
  NOT_YOUR_OFFER: [403, 'This offer belongs to another contributor.'],
};

class AppError extends Error {
  constructor(code, { taskId = null, message } = {}) {
    const [status, text] = ERRORS[code];
    super(message || text);
    this.code = code;
    this.status = status;
    this.taskId = taskId;
  }
}

module.exports = { AppError };
