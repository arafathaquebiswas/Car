// Wraps an async route handler so a rejected promise is forwarded to
// Express's error-handling middleware instead of crashing the process.
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
