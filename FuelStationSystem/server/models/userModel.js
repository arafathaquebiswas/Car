const pool = require("../config/db");
const ApiError = require("../utils/ApiError");
const { deleteUploadedFile } = require("../utils/fileCleanup");

// Fields safe to return to clients — never includes password_hash.
const SAFE_FIELDS = `
  u.id, u.username, u.full_name, u.role, u.driver_id, u.sir_id,
  u.phone, u.email, u.employee_id, u.profile_photo, u.last_login_at,
  u.password_changed_at, u.is_active, u.created_at, u.updated_at
`;

function normalizeBdPhone(phone) {
  if (!phone || typeof phone !== "string") return null;
  const trimmed = phone.trim().replace(/[\s-]/g, "");
  let numStr = trimmed;
  if (numStr.startsWith("+88")) {
    numStr = numStr.slice(3);
  } else if (numStr.startsWith("88")) {
    numStr = numStr.slice(2);
  }
  if (/^01[3-9]\d{8}$/.test(numStr)) {
    return `+88${numStr}`;
  }
  return null;
}

async function findByPhone(phone, excludeUserId = null) {
  if (!phone) return null;
  const normalized = normalizeBdPhone(phone);
  if (!normalized) return null;

  let sql = "SELECT id FROM users WHERE phone = ?";
  const params = [normalized];
  if (excludeUserId) {
    sql += " AND id != ?";
    params.push(excludeUserId);
  }
  sql += " LIMIT 1";
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

async function findByUsername(username) {
  const [rows] = await pool.query("SELECT * FROM users WHERE username = ? LIMIT 1", [username]);
  return rows[0] || null;
}

// Includes password_hash — for internal use only (e.g. change-password's
// current-password check). Never send this row to a client as-is.
async function findByIdRaw(id) {
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await pool.query(`SELECT ${SAFE_FIELDS} FROM users u WHERE u.id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

// Richer single-record view for the admin edit screen — includes the
// linked driver/sir row's role-specific fields.
async function findDetailedById(id) {
  const [rows] = await pool.query(
    `SELECT ${SAFE_FIELDS}, d.vehicle_numbers, d.default_fuel_type_id, s.department, s.designation
     FROM users u
     LEFT JOIN drivers d ON d.id = u.driver_id
     LEFT JOIN office_sirs s ON s.id = u.sir_id
     WHERE u.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function findByEmployeeId(employeeId) {
  if (!employeeId) return null;
  const [rows] = await pool.query("SELECT id FROM users WHERE employee_id = ? LIMIT 1", [employeeId]);
  return rows[0] || null;
}

// Admin "User Management" list — search across name/username/email/employee
// id, plus optional role and active/inactive filters.
async function findAll({ search, role, status } = {}) {
  const where = [];
  const params = [];

  if (search) {
    where.push("(u.full_name LIKE ? OR u.username LIKE ? OR u.email LIKE ? OR u.employee_id LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (role) {
    where.push("u.role = ?");
    params.push(role);
  }
  if (status === "active") where.push("u.is_active = 1");
  else if (status === "inactive") where.push("u.is_active = 0");

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await pool.query(
    `SELECT ${SAFE_FIELDS}, d.vehicle_numbers, d.default_fuel_type_id, s.department, s.designation
     FROM users u
     LEFT JOIN drivers d ON d.id = u.driver_id
     LEFT JOIN office_sirs s ON s.id = u.sir_id
     ${whereSql}
     ORDER BY u.created_at DESC`,
    params
  );
  return rows;
}

// Creates the login account and, for driver/sir roles, the linked profile
// row (drivers / office_sirs) in the same transaction — so a user account
// never exists without its role-specific profile, and vice versa.
async function create({
  username, passwordHash, fullName, role,
  phone = null, email = null, employeeId = null, profilePhoto = null,
  vehicleNumbers = null, defaultFuelTypeId = null,
  department = null, designation = null,
}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let driverId = null;
    let sirId = null;

    if (role === "driver") {
      const [[dupe]] = await conn.query("SELECT id FROM drivers WHERE name = ?", [fullName]);
      if (dupe) throw new ApiError(409, `A driver named "${fullName}" already exists. Use a different full name.`);
      const [result] = await conn.query(
        "INSERT INTO drivers (name, vehicle_numbers, default_fuel_type_id) VALUES (?, ?, ?)",
        [fullName, vehicleNumbers ? JSON.stringify(vehicleNumbers) : null, defaultFuelTypeId]
      );
      driverId = result.insertId;
    } else if (role === "sir") {
      const [[dupe]] = await conn.query("SELECT id FROM office_sirs WHERE name = ?", [fullName]);
      if (dupe) throw new ApiError(409, `A sir named "${fullName}" already exists. Use a different full name.`);
      const [result] = await conn.query(
        "INSERT INTO office_sirs (name, department, designation) VALUES (?, ?, ?)",
        [fullName, department, designation]
      );
      sirId = result.insertId;
    }

    const [userResult] = await conn.query(
      `INSERT INTO users
        (username, password_hash, full_name, role, driver_id, sir_id, phone, email, employee_id, profile_photo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [username, passwordHash, fullName, role, driverId, sirId, phone, email, employeeId, profilePhoto]
    );

    await conn.commit();
    return findDetailedById(userResult.insertId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Partial update — only fields explicitly present (not undefined) are
// changed. Also keeps the linked drivers/office_sirs row in sync so the
// driver/sir's own name & role-specific fields never drift from the user row.
async function update(id, fields = {}) {
  const existing = await findDetailedById(id);
  if (!existing) return null;

  const {
    fullName, phone, email, employeeId, profilePhoto,
    vehicleNumbers, defaultFuelTypeId, department, designation,
  } = fields;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const userSet = [];
    const userParams = [];
    if (fullName !== undefined) { userSet.push("full_name = ?"); userParams.push(fullName); }
    if (phone !== undefined) { userSet.push("phone = ?"); userParams.push(phone); }
    if (email !== undefined) { userSet.push("email = ?"); userParams.push(email); }
    if (employeeId !== undefined) { userSet.push("employee_id = ?"); userParams.push(employeeId); }
    if (profilePhoto !== undefined) { userSet.push("profile_photo = ?"); userParams.push(profilePhoto); }
    if (userSet.length) {
      userParams.push(id);
      await conn.query(`UPDATE users SET ${userSet.join(", ")} WHERE id = ?`, userParams);
    }

    if (existing.role === "driver" && existing.driver_id) {
      if (fullName !== undefined && fullName !== existing.full_name) {
        const [[dupe]] = await conn.query("SELECT id FROM drivers WHERE name = ? AND id != ?", [fullName, existing.driver_id]);
        if (dupe) throw new ApiError(409, `A driver named "${fullName}" already exists. Use a different full name.`);
      }
      const driverSet = [];
      const driverParams = [];
      if (fullName !== undefined) { driverSet.push("name = ?"); driverParams.push(fullName); }
      if (vehicleNumbers !== undefined) {
        driverSet.push("vehicle_numbers = ?");
        driverParams.push(vehicleNumbers ? JSON.stringify(vehicleNumbers) : null);
      }
      if (defaultFuelTypeId !== undefined) { driverSet.push("default_fuel_type_id = ?"); driverParams.push(defaultFuelTypeId); }
      if (profilePhoto !== undefined) { driverSet.push("photo_path = ?"); driverParams.push(profilePhoto); }
      if (driverSet.length) {
        driverParams.push(existing.driver_id);
        await conn.query(`UPDATE drivers SET ${driverSet.join(", ")} WHERE id = ?`, driverParams);
      }
    } else if (existing.role === "sir" && existing.sir_id) {
      if (fullName !== undefined && fullName !== existing.full_name) {
        const [[dupe]] = await conn.query("SELECT id FROM office_sirs WHERE name = ? AND id != ?", [fullName, existing.sir_id]);
        if (dupe) throw new ApiError(409, `A sir named "${fullName}" already exists. Use a different full name.`);
      }
      const sirSet = [];
      const sirParams = [];
      if (fullName !== undefined) { sirSet.push("name = ?"); sirParams.push(fullName); }
      if (department !== undefined) { sirSet.push("department = ?"); sirParams.push(department); }
      if (designation !== undefined) { sirSet.push("designation = ?"); sirParams.push(designation); }
      if (sirSet.length) {
        sirParams.push(existing.sir_id);
        await conn.query(`UPDATE office_sirs SET ${sirSet.join(", ")} WHERE id = ?`, sirParams);
      }
    }

    await conn.commit();
    return findDetailedById(id);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function resetPassword(id, passwordHash) {
  await pool.query("UPDATE users SET password_hash = ?, password_changed_at = NOW() WHERE id = ?", [passwordHash, id]);
}

async function setActive(id, isActive) {
  await pool.query("UPDATE users SET is_active = ? WHERE id = ?", [isActive ? 1 : 0, id]);
  return findDetailedById(id);
}

// Deletes only the login account — the linked drivers/office_sirs row stays,
// since past fuel_records still reference it and must keep showing a name.
async function remove(id) {
  await pool.query("DELETE FROM users WHERE id = ?", [id]);
}

async function updateLastLogin(id) {
  await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = ?", [id]);
}

async function logAudit(userId, username, action, ipAddress = null, note = "") {
  try {
    await pool.query(
      "INSERT INTO user_audit_logs (user_id, username, action, ip_address, note) VALUES (?, ?, ?, ?, ?)",
      [userId, username, action || "Profile Event", ipAddress || null, note || ""]
    );
  } catch (err) {
    console.error("Failed to log audit event:", err.message);
  }
}

async function getAuditLogs(userId) {
  const [rows] = await pool.query(
    "SELECT id, action, ip_address, note, created_at FROM user_audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 50",
    [userId]
  );
  return rows;
}

async function deleteProfilePhoto(userId, adminUsername, reason = "") {
  const user = await findDetailedById(userId);
  if (!user) throw new ApiError(404, "User not found.");

  if (!user.profile_photo) {
    throw new ApiError(400, "User does not have a profile photo.");
  }

  deleteUploadedFile(user.profile_photo);
  await pool.query("UPDATE users SET profile_photo = NULL WHERE id = ?", [userId]);
  if (user.driver_id) {
    await pool.query("UPDATE drivers SET photo_path = NULL WHERE id = ?", [user.driver_id]);
  }

  const note = `Admin "${adminUsername}" deleted profile photo for user "${user.username}".${reason ? ` Reason: ${reason}` : ""}`;
  await logAudit(userId, adminUsername, "Profile Picture Deleted", null, note);
  return findDetailedById(userId);
}

async function getDriverProfile(userId) {
  const [rows] = await pool.query("SELECT * FROM driver_profiles WHERE user_id = ? LIMIT 1", [userId]);
  return rows[0] || null;
}

async function upsertDriverProfile(userId, profileData) {
  const existing = await getDriverProfile(userId);
  const fields = {
    user_id: userId,
    dob: profileData.dob || null,
    gender: profileData.gender || null,
    blood_group: profileData.bloodGroup || null,
    permanent_address: profileData.permanentAddress || null,
    present_address: profileData.presentAddress || null,
    emergency_contact_name: profileData.emergencyContactName || null,
    emergency_contact_number: profileData.emergencyContactNumber || null,
    nid_number: profileData.nidNumber || null,
    nid_front_image: profileData.nidFrontImage !== undefined ? profileData.nidFrontImage : (existing ? existing.nid_front_image : null),
    nid_back_image: profileData.nidBackImage !== undefined ? profileData.nidBackImage : (existing ? existing.nid_back_image : null),
    nid_issue_date: profileData.nidIssueDate || null,
    nid_expiry_date: profileData.nidExpiryDate || null,
    license_number: profileData.licenseNumber || null,
    license_front_image: profileData.licenseFrontImage !== undefined ? profileData.licenseFrontImage : (existing ? existing.license_front_image : null),
    license_back_image: profileData.licenseBackImage !== undefined ? profileData.licenseBackImage : (existing ? existing.license_back_image : null),
    license_issue_date: profileData.licenseIssueDate || null,
    license_expiry_date: profileData.licenseExpiryDate || null,
    license_category: profileData.licenseCategory || null,
    license_authority: profileData.licenseAuthority || null,
    verification_status: profileData.verificationStatus || (existing ? existing.verification_status : "Pending Verification"),
  };

  if (!existing) {
    const keys = Object.keys(fields);
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO driver_profiles (${keys.join(", ")}) VALUES (${placeholders})`;
    await pool.query(sql, Object.values(fields));
  } else {
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (k !== "user_id" && v !== undefined) {
        sets.push(`${k} = ?`);
        params.push(v);
      }
    }
    if (sets.length) {
      params.push(userId);
      await pool.query(`UPDATE driver_profiles SET ${sets.join(", ")} WHERE user_id = ?`, params);
    }
  }
  return getDriverProfile(userId);
}

module.exports = {
  SAFE_FIELDS,
  normalizeBdPhone,
  findByPhone,
  findByUsername,
  findByIdRaw,
  findById,
  findDetailedById,
  findByEmployeeId,
  findAll,
  create,
  update,
  resetPassword,
  setActive,
  remove,
  updateLastLogin,
  getDriverProfile,
  upsertDriverProfile,
  logAudit,
  getAuditLogs,
  deleteProfilePhoto,
};
