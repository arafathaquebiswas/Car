// A simple error class that carries an HTTP status code, so route handlers
// can `throw new ApiError(404, "Record not found")` and the central error
// handler (middleware/errorHandler.js) turns it into the right JSON response.
class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = ApiError;
