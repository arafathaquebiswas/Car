const multer = require("multer");
const { logger } = require("../utils/logger");

// Central error handler — every asyncHandler-wrapped route and every
// throw new ApiError(...) ends up here, so JSON error responses stay
// consistent across the whole API.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  let statusCode = err.statusCode || 500;
  let message = err.message || "Something went wrong.";

  if (err instanceof multer.MulterError) {
    statusCode = 400;
    if (err.code === "LIMIT_FILE_SIZE") message = "One of the uploaded files is too large.";
    else if (err.code === "LIMIT_FILE_COUNT") message = "Too many files uploaded.";
  }

  // MySQL duplicate-entry (unique constraint) errors, e.g. driver name reused.
  if (err.code === "ER_DUP_ENTRY") {
    statusCode = 409;
    message = "That value already exists — please use a different name.";
  }

  // MySQL foreign-key errors, e.g. deleting a driver that still has fuel records.
  if (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED") {
    statusCode = 409;
    message = "This item is still used by existing fuel records and can't be deleted.";
  }

  if (statusCode === 500) {
    logger.error(`[500 Internal Server Error] ${req.method} ${req.originalUrl}`, err);
    if (process.env.NODE_ENV === "production") {
      message = "An unexpected server error occurred. Please contact system admin.";
    }
  }

  res.status(statusCode).json({ success: false, message });
}

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: `No route: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFoundHandler };
