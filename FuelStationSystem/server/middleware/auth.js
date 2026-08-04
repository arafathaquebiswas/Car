const ApiError = require("../utils/ApiError");
const { verifyToken } = require("../utils/jwt");

// Authentication middleware: requires a valid "Authorization: Bearer <token>"
// header. Attaches the decoded { id, username, role } to req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new ApiError(401, "Not authenticated — please log in.");
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    throw new ApiError(401, "Session expired or invalid — please log in again.");
  }
}

// Authorization middleware factory: requireRole("admin", "sir") only lets
// through users whose role is in the allowed list. Must run after requireAuth.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) throw new ApiError(401, "Not authenticated.");
    if (!allowedRoles.includes(req.user.role)) {
      throw new ApiError(403, "You don't have permission to perform this action.");
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
