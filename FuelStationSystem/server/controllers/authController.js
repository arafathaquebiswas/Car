const bcrypt = require("bcryptjs");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const { signToken } = require("../utils/jwt");
const { SALT_ROUNDS } = require("../config/seed");
const userModel = require("../models/userModel");

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    throw new ApiError(400, "Username and password are required.");
  }

  const user = await userModel.findByUsername(username);
  if (!user || !user.is_active) {
    throw new ApiError(401, "Invalid username or password.");
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    throw new ApiError(401, "Invalid username or password.");
  }

  await userModel.updateLastLogin(user.id);

  const token = signToken({
    id: user.id, username: user.username, role: user.role,
    driverId: user.driver_id, sirId: user.sir_id,
  });
  res.json({
    success: true,
    token,
    user: {
      id: user.id, username: user.username, fullName: user.full_name, role: user.role,
      driverId: user.driver_id, sirId: user.sir_id, phone: user.phone, email: user.email,
      employeeId: user.employee_id, profilePhoto: user.profile_photo,
    },
  });
});

// GET /api/auth/me — used on page load to confirm the stored token is still valid
const me = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user.id);
  if (!user) throw new ApiError(404, "User not found.");
  res.json({
    success: true,
    user: {
      id: user.id, username: user.username, fullName: user.full_name, role: user.role,
      driverId: user.driver_id, sirId: user.sir_id, phone: user.phone, email: user.email,
      employeeId: user.employee_id, profilePhoto: user.profile_photo,
    },
  });
});

// POST /api/auth/logout — JWTs are stateless, so logout is really just the
// client discarding its token; this endpoint exists for a clean API shape
// and a place to add token-blacklisting later if ever needed.
const logout = asyncHandler(async (req, res) => {
  res.json({ success: true, message: "Logged out." });
});

// POST /api/auth/register — admin-only, lets an admin create Sir/Driver
// login accounts (the app ships with a single seeded admin only).
const register = asyncHandler(async (req, res) => {
  const { username, password, fullName, role } = req.body;
  if (!username || !password || !fullName || !role) {
    throw new ApiError(400, "username, password, fullName, and role are required.");
  }
  if (!["admin", "sir", "driver"].includes(role)) {
    throw new ApiError(400, "role must be admin, sir, or driver.");
  }
  if (password.length < 6) {
    throw new ApiError(400, "Password must be at least 6 characters.");
  }

  const existing = await userModel.findByUsername(username);
  if (existing) throw new ApiError(409, "That username is already taken.");

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await userModel.create({ username, passwordHash, fullName, role });
  res.status(201).json({ success: true, user });
});

module.exports = { login, me, logout, register };
