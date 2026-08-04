const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");
const userModel = require("../models/userModel");
const notificationModel = require("../models/notificationModel");
const { SALT_ROUNDS } = require("../config/seed");
const { toRelativePath } = require("../middleware/upload");
const { deleteUploadedFile } = require("../utils/fileCleanup");

const ROLES = ["admin", "sir", "driver"];

// Accepts either a JSON array string (`'["DHK-1234","DHK-5678"]'`), a plain
// comma-separated string, or an actual array (from a non-multipart client),
// and always returns a clean array of trimmed, non-empty plate numbers.
function parseVehicleNumbers(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch (_) {
      // Not JSON — fall through to comma-splitting.
    }
    return raw.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return null;
}

async function validateFuelTypeId(id) {
  if (!id) return;
  const [rows] = await pool.query("SELECT id FROM fuel_types WHERE id = ?", [id]);
  if (!rows.length) throw new ApiError(400, "Invalid default fuel type.");
}

function cleanupIfUploaded(req) {
  if (req.file) deleteUploadedFile(toRelativePath(req.file));
}

// GET /api/users — admin-only User Management table, with search + filters.
const list = asyncHandler(async (req, res) => {
  const { search, role, status } = req.query;
  const users = await userModel.findAll({ search, role, status });
  res.json({ success: true, data: users });
});

// GET /api/users/:id
const getOne = asyncHandler(async (req, res) => {
  const user = await userModel.findDetailedById(req.params.id);
  if (!user) throw new ApiError(404, "User not found.");
  res.json({ success: true, data: user });
});

// POST /api/users — creates an Admin, Sir, or Driver account. For Sir/Driver
// roles this also creates the linked office_sirs/drivers profile row.
const create = asyncHandler(async (req, res) => {
  try {
    const body = req.body;
    const role = body.role;

    if (!body.username || !body.password || !body.fullName || !role) {
      throw new ApiError(400, "username, password, fullName, and role are required.");
    }
    if (!ROLES.includes(role)) throw new ApiError(400, "role must be admin, sir, or driver.");
    if (body.password.length < 6) throw new ApiError(400, "Password must be at least 6 characters.");

    const existingUsername = await userModel.findByUsername(body.username);
    if (existingUsername) throw new ApiError(409, "That username is already taken.");

    if (body.employeeId) {
      const existingEmployee = await userModel.findByEmployeeId(body.employeeId);
      if (existingEmployee) throw new ApiError(409, "That employee ID is already in use.");
    }

    let normalizedPhone = null;
    if (body.phone) {
      normalizedPhone = userModel.normalizeBdPhone(body.phone);
      if (!normalizedPhone) {
        throw new ApiError(400, "Please enter a valid Bangladesh mobile number (e.g. 01712345678 or +8801712345678).");
      }
      const existingPhone = await userModel.findByPhone(normalizedPhone);
      if (existingPhone) throw new ApiError(409, "That phone number is already registered to another user.");
    }

    const defaultFuelTypeId = role === "driver" && body.defaultFuelTypeId ? Number(body.defaultFuelTypeId) : null;
    if (defaultFuelTypeId) await validateFuelTypeId(defaultFuelTypeId);

    const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);
    const profilePhoto = req.file ? toRelativePath(req.file) : null;

    const user = await userModel.create({
      username: body.username,
      passwordHash,
      fullName: body.fullName,
      role,
      phone: normalizedPhone,
      email: body.email || null,
      employeeId: body.employeeId || null,
      profilePhoto,
      vehicleNumbers: role === "driver" ? parseVehicleNumbers(body.vehicleNumbers) : null,
      defaultFuelTypeId,
      department: role === "sir" ? (body.department || null) : null,
      designation: role === "sir" ? (body.designation || null) : null,
    });

    res.status(201).json({ success: true, data: user });
  } catch (err) {
    cleanupIfUploaded(req);
    throw err;
  }
});

// PUT /api/users/:id — admin edit. Username and role are permanent once
// created (changing role would orphan the linked driver/sir profile), so
// neither is accepted here.
const update = asyncHandler(async (req, res) => {
  const existing = await userModel.findDetailedById(req.params.id);
  if (!existing) {
    cleanupIfUploaded(req);
    throw new ApiError(404, "User not found.");
  }

  try {
    const body = req.body;

    if (body.employeeId && body.employeeId !== existing.employee_id) {
      const dupe = await userModel.findByEmployeeId(body.employeeId);
      if (dupe) throw new ApiError(409, "That employee ID is already in use.");
    }

    let normalizedPhone = undefined;
    if (body.phone !== undefined) {
      if (!body.phone.trim()) throw new ApiError(400, "Phone number is mandatory.");
      normalizedPhone = userModel.normalizeBdPhone(body.phone);
      if (!normalizedPhone) {
        throw new ApiError(400, "Please enter a valid Bangladesh mobile number (e.g. 01712345678 or +8801712345678).");
      }
      const existingPhone = await userModel.findByPhone(normalizedPhone, req.params.id);
      if (existingPhone) throw new ApiError(409, "That phone number is already registered to another user.");
    }

    if (existing.role === "driver" && body.defaultFuelTypeId) {
      await validateFuelTypeId(Number(body.defaultFuelTypeId));
    }

    const newProfilePhoto = req.file
      ? toRelativePath(req.file)
      : body.removeProfilePhoto === "true"
        ? null
        : undefined;

    const updated = await userModel.update(req.params.id, {
      fullName: body.fullName !== undefined ? body.fullName : undefined,
      phone: normalizedPhone,
      email: body.email !== undefined ? body.email : undefined,
      // Empty string means "cleared" — store as NULL, not "", so multiple
      // users who clear their employee ID don't collide on the unique index.
      employeeId: body.employeeId !== undefined ? (body.employeeId || null) : undefined,
      profilePhoto: newProfilePhoto,
      vehicleNumbers: existing.role === "driver" && body.vehicleNumbers !== undefined
        ? parseVehicleNumbers(body.vehicleNumbers) : undefined,
      defaultFuelTypeId: existing.role === "driver" && body.defaultFuelTypeId !== undefined
        ? (body.defaultFuelTypeId ? Number(body.defaultFuelTypeId) : null) : undefined,
      department: existing.role === "sir" && body.department !== undefined ? body.department : undefined,
      designation: existing.role === "sir" && body.designation !== undefined ? body.designation : undefined,
    });

    // Only delete the old photo after the DB write succeeds, and only if it
    // was actually replaced or explicitly removed.
    if ((req.file || body.removeProfilePhoto === "true") && existing.profile_photo) {
      deleteUploadedFile(existing.profile_photo);
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    cleanupIfUploaded(req);
    throw err;
  }
});

// POST /api/users/:id/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    throw new ApiError(400, "New password must be at least 6 characters.");
  }
  const existing = await userModel.findById(req.params.id);
  if (!existing) throw new ApiError(404, "User not found.");

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await userModel.resetPassword(req.params.id, passwordHash);
  res.json({ success: true, message: "Password has been reset." });
});

function buildSetActive(isActive) {
  return asyncHandler(async (req, res) => {
    const existing = await userModel.findById(req.params.id);
    if (!existing) throw new ApiError(404, "User not found.");
    if (!isActive && req.user.id === Number(req.params.id)) {
      throw new ApiError(400, "You cannot deactivate your own account.");
    }
    const updated = await userModel.setActive(req.params.id, isActive);
    res.json({ success: true, data: updated });
  });
}

const activate = buildSetActive(true);
const deactivate = buildSetActive(false);

// DELETE /api/users/:id — removes the login account only; the linked
// drivers/office_sirs row (and its historical fuel records) is kept.
const remove = asyncHandler(async (req, res) => {
  const existing = await userModel.findById(req.params.id);
  if (!existing) throw new ApiError(404, "User not found.");
  if (req.user.id === Number(req.params.id)) throw new ApiError(400, "You cannot delete your own account.");

  await userModel.remove(req.params.id);
  if (existing.profile_photo) deleteUploadedFile(existing.profile_photo);
  res.json({ success: true, message: `User "${existing.username}" deleted.` });
});

// GET /api/users/me — any authenticated role, own profile.
const getMe = asyncHandler(async (req, res) => {
  const user = await userModel.findDetailedById(req.user.id);
  if (!user) throw new ApiError(404, "User not found.");
  res.json({ success: true, data: user });
});

// GET /api/users/me/audit-logs — return self audit logs
const getMyAuditLogs = asyncHandler(async (req, res) => {
  const logs = await userModel.getAuditLogs(req.user.id);
  res.json({ success: true, data: logs });
});

// PUT /api/users/me — self-service edit. Deliberately limited to contact
// info + photo; username/role/employeeId and driver/sir operational fields
// (vehicle numbers, department, etc.) stay admin-controlled.
const updateMe = asyncHandler(async (req, res) => {
  const existing = await userModel.findDetailedById(req.user.id);
  if (!existing) {
    cleanupIfUploaded(req);
    throw new ApiError(404, "User not found.");
  }

  try {
    const body = req.body;
    let normalizedPhone = undefined;

    if (body.phone !== undefined) {
      if (!body.phone.trim()) {
        throw new ApiError(400, "Phone number is mandatory.");
      }
      normalizedPhone = userModel.normalizeBdPhone(body.phone);
      if (!normalizedPhone) {
        throw new ApiError(400, "Please enter a valid Bangladesh mobile number (e.g. 01712345678 or +8801712345678).");
      }
      const existingPhone = await userModel.findByPhone(normalizedPhone, req.user.id);
      if (existingPhone) {
        throw new ApiError(409, "That phone number is already registered to another user.");
      }
    }

    const newProfilePhoto = req.file
      ? toRelativePath(req.file)
      : body.removeProfilePhoto === "true"
        ? null
        : undefined;

    const updated = await userModel.update(req.user.id, {
      fullName: body.fullName !== undefined ? body.fullName : undefined,
      phone: normalizedPhone,
      email: body.email !== undefined ? body.email : undefined,
      profilePhoto: newProfilePhoto,
    });

    if ((req.file || body.removeProfilePhoto === "true") && existing.profile_photo) {
      deleteUploadedFile(existing.profile_photo);
    }

    // Record audit events & notifications
    if (newProfilePhoto !== undefined && newProfilePhoto !== existing.profile_photo) {
      await userModel.logAudit(req.user.id, req.user.username, "Profile Picture Changed", req.ip,
        newProfilePhoto ? "Updated profile photo" : "Removed profile photo");
    }
    if (normalizedPhone !== undefined && normalizedPhone !== existing.phone) {
      await userModel.logAudit(req.user.id, req.user.username, "Phone Number Changed", req.ip,
        `Updated phone number to ${normalizedPhone}`);
    }
    if (body.fullName !== undefined && body.fullName !== existing.full_name) {
      await userModel.logAudit(req.user.id, req.user.username, "Profile Updated", req.ip,
        `Updated full name to ${body.fullName}`);
    }

    await notificationModel.create({
      recipientId: req.user.id,
      title: "Profile Updated Successfully",
      message: "Your profile information has been updated successfully.",
      type: "success",
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    cleanupIfUploaded(req);
    throw err;
  }
});

// POST /api/users/me/change-password
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword) {
    throw new ApiError(400, "Current password and new password are required.");
  }
  if (confirmPassword !== undefined && newPassword !== confirmPassword) {
    throw new ApiError(400, "New password and confirmation password do not match.");
  }
  if (newPassword.length < 8) {
    throw new ApiError(400, "New password must be at least 8 characters.");
  }

  const user = await userModel.findByIdRaw(req.user.id);
  if (!user) throw new ApiError(404, "User not found.");

  const matches = await bcrypt.compare(currentPassword, user.password_hash);
  if (!matches) throw new ApiError(401, "Current password is incorrect.");

  const isReused = await bcrypt.compare(newPassword, user.password_hash);
  if (isReused) {
    throw new ApiError(400, "New password cannot be the same as your current password.");
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await userModel.resetPassword(req.user.id, passwordHash);

  await userModel.logAudit(req.user.id, req.user.username, "Password Changed", req.ip, "User changed account password");

  await notificationModel.create({
    recipientId: req.user.id,
    title: "Password Changed",
    message: "Your account password was updated successfully.",
    type: "warning",
  });

  res.json({ success: true, message: "Password changed successfully." });
});

const deleteProfilePhoto = asyncHandler(async (req, res) => {
  const user = await userModel.deleteProfilePhoto(req.params.id, req.user.username, req.body ? req.body.reason : "");
  res.json({ success: true, message: "Profile photo deleted successfully.", data: user });
});

// GET /api/users/:id/driver-profile — get detailed driver profile with NID & License info
const getDriverProfile = asyncHandler(async (req, res) => {
  const targetUserId = req.params.id ? Number(req.params.id) : req.user.id;
  if (req.user.role === "driver" && req.user.id !== targetUserId) {
    throw new ApiError(403, "You do not have permission to view other driver profiles.");
  }

  const profile = await userModel.getDriverProfile(targetUserId);
  res.json({ success: true, data: profile });
});

// PUT /api/users/:id/driver-profile — update extended driver profile, NID & Driving License
const updateDriverProfile = asyncHandler(async (req, res) => {
  const targetUserId = req.params.id ? Number(req.params.id) : req.user.id;
  if (req.user.role === "driver" && req.user.id !== targetUserId) {
    cleanupIfUploaded(req);
    throw new ApiError(403, "You can only update your own driver profile.");
  }

  const existingProfile = await userModel.getDriverProfile(targetUserId);
  const files = req.files || {};
  const body = req.body || {};

  const handleDocFile = (fieldName, dbField) => {
    if (files[fieldName] && files[fieldName][0]) {
      const newPath = toRelativePath(files[fieldName][0]);
      if (existingProfile && existingProfile[dbField]) {
        deleteUploadedFile(existingProfile[dbField]);
        userModel.logAudit({
          userId: req.user.id,
          username: req.user.username,
          action: `${fieldName.toUpperCase()} Replaced`,
          note: `Replaced physical document file for user ID ${targetUserId}`,
        });
      } else {
        userModel.logAudit({
          userId: req.user.id,
          username: req.user.username,
          action: `${fieldName.toUpperCase()} Uploaded`,
          note: `Uploaded physical document file for user ID ${targetUserId}`,
        });
      }
      return newPath;
    }
    return undefined;
  };

  const nidFrontImage = handleDocFile("nidFront", "nid_front_image");
  const nidBackImage = handleDocFile("nidBack", "nid_back_image");
  const licenseFrontImage = handleDocFile("licenseFront", "license_front_image");
  const licenseBackImage = handleDocFile("licenseBack", "license_back_image");
  const otherDocumentImage = handleDocFile("otherDoc", "other_document_image");

  const updatedProfile = await userModel.upsertDriverProfile(targetUserId, {
    dob: body.dob !== undefined ? body.dob : undefined,
    gender: body.gender !== undefined ? body.gender : undefined,
    bloodGroup: body.bloodGroup !== undefined ? body.bloodGroup : undefined,
    permanentAddress: body.permanentAddress !== undefined ? body.permanentAddress : undefined,
    presentAddress: body.presentAddress !== undefined ? body.presentAddress : undefined,
    emergencyContactName: body.emergencyContactName !== undefined ? body.emergencyContactName : undefined,
    emergencyContactNumber: body.emergencyContactNumber !== undefined ? body.emergencyContactNumber : undefined,
    nidNumber: body.nidNumber !== undefined ? body.nidNumber : undefined,
    nidFrontImage,
    nidBackImage,
    nidIssueDate: body.nidIssueDate !== undefined ? body.nidIssueDate : undefined,
    nidExpiryDate: body.nidExpiryDate !== undefined ? body.nidExpiryDate : undefined,
    licenseNumber: body.licenseNumber !== undefined ? body.licenseNumber : undefined,
    licenseFrontImage,
    licenseBackImage,
    licenseIssueDate: body.licenseIssueDate !== undefined ? body.licenseIssueDate : undefined,
    licenseExpiryDate: body.licenseExpiryDate !== undefined ? body.licenseExpiryDate : undefined,
    licenseCategory: body.licenseCategory !== undefined ? body.licenseCategory : undefined,
    licenseAuthority: body.licenseAuthority !== undefined ? body.licenseAuthority : undefined,
    otherDocumentImage,
  });

  await userModel.logAudit({
    userId: req.user.id,
    username: req.user.username,
    action: "Driver Profile Updated",
    note: `Updated driver NID & license profile for user ID ${targetUserId}`,
  });

  res.json({ success: true, data: updatedProfile });
});

// PUT /api/users/:id/verification-status — Admin / Sir updates driver verification status
const updateVerificationStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const allowed = ["Pending Verification", "Verified", "Rejected", "Expired Documents"];
  if (!allowed.includes(status)) {
    throw new ApiError(400, `Invalid verification status. Allowed: ${allowed.join(", ")}`);
  }

  const updated = await userModel.upsertDriverProfile(req.params.id, {
    verificationStatus: status,
  });

  await userModel.logAudit({
    userId: req.user.id,
    username: req.user.username,
    action: "Verification Status Changed",
    note: `Set verification status to "${status}" for driver user ID ${req.params.id}`,
  });

  res.json({ success: true, data: updated });
});

module.exports = {
  list,
  getOne,
  create,
  update,
  resetPassword,
  activate,
  deactivate,
  remove,
  getMe,
  getMyAuditLogs,
  updateMe,
  changePassword,
  deleteProfilePhoto,
  getDriverProfile,
  updateDriverProfile,
  updateVerificationStatus,
};
