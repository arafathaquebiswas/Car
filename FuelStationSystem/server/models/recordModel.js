const pool = require("../config/db");
const ApiError = require("../utils/ApiError");
const { nextRecordCode } = require("../utils/recordCode");
const { deleteUploadedFile } = require("../utils/fileCleanup");

// Fields that represent the actual facts a sir approved when signing.
// If any of these change on an already-approved record, the approval must
// be revoked and the record must be re-approved & re-signed. Mirrors the
// same list the original frontend used client-side — now enforced here,
// server-side, since the client can no longer be trusted with this decision.
const APPROVAL_SENSITIVE_FIELDS = [
  "date", "driver", "sirName", "vehicleNumber", "fuelType",
  "liters", "pricePerLiter", "totalAmount", "receiptNumber",
  "stationName", "odometer", "fuelReceiptImage", "moneyReceiptImage",
];

const SELECT_BASE = `
  SELECT
    r.id, r.record_code, r.record_date, r.record_time,
    d.name AS driver_name, s.name AS sir_name, ft.name AS fuel_type_name,
    r.vehicle_number, r.station_name, r.odometer,
    r.liters, r.price_per_liter, r.total_amount, r.receipt_number,
    r.remarks, r.office_remarks,
    r.fuel_receipt_image, r.money_receipt_image, r.driver_photo_image,
    r.vehicle_photo_image, r.signature_image,
    r.is_draft, r.machine_photo_reviewed, r.money_receipt_reviewed, r.approval_status,
    r.approved_by, r.approved_at, r.is_locked, r.fuel_received,
    r.created_at, r.updated_at
  FROM fuel_records r
  JOIN drivers d ON d.id = r.driver_id
  LEFT JOIN office_sirs s ON s.id = r.sir_id
  LEFT JOIN fuel_types ft ON ft.id = r.fuel_type_id
`;

// Converts a joined DB row into the exact JSON shape the frontend already
// works with (same field names it used against LocalStorage), so the
// rendering/search/report code in script.js barely has to change.
function rowToApi(row, history = []) {
  return {
    id: row.record_code,
    _dbId: row.id, // internal numeric id, used for API calls (update/delete/approve/...)
    date: row.record_date,
    time: row.record_time,
    driver: row.driver_name,
    sirName: row.sir_name,
    vehicleNumber: row.vehicle_number,
    fuelType: row.fuel_type_name,
    liters: Number(row.liters),
    pricePerLiter: Number(row.price_per_liter),
    totalAmount: Number(row.total_amount),
    receiptNumber: row.receipt_number,
    remarks: row.remarks,
    officeRemarks: row.office_remarks,
    stationName: row.station_name,
    odometer: row.odometer,
    fuelReceiptImage: row.fuel_receipt_image,
    moneyReceiptImage: row.money_receipt_image,
    driverPhotoImage: row.driver_photo_image,
    vehiclePhotoImage: row.vehicle_photo_image,
    signature: row.signature_image,
    isDraft: !!row.is_draft,
    machinePhotoReviewed: !!row.machine_photo_reviewed,
    moneyReceiptReviewed: !!row.money_receipt_reviewed,
    // Derived for backward compatibility with the existing status-badge /
    // approve-gate logic, which only needs to know "has everything required
    // been reviewed" — true only once BOTH mandatory photos are reviewed.
    reviewedForApproval: !!(row.machine_photo_reviewed && row.money_receipt_reviewed),
    approvalStatus: row.approval_status,
    approvedBy: row.approved_by,
    signedAt: row.approved_at ? new Date(row.approved_at).getTime() : null,
    locked: !!row.is_locked,
    fuelReceived: row.fuel_received,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    history: history.map((h) => ({
      action: h.action,
      by: h.performed_by,
      at: new Date(h.created_at).getTime(),
      note: h.note || "",
    })),
  };
}

async function getHistory(recordDbId) {
  const [rows] = await pool.query(
    "SELECT action, performed_by, note, created_at FROM approval_history WHERE record_id = ? ORDER BY id ASC",
    [recordDbId]
  );
  return rows;
}

// One batched query for every record's history instead of one query PER
// record — getAll() used to run N+1 queries (1 for the records, N for each
// row's history via Promise.all), which scales badly once the table has a
// few hundred/thousand records. Returns { [recordDbId]: historyRows[] }.
async function getHistoryForIds(recordDbIds) {
  if (!recordDbIds.length) return {};
  const placeholders = recordDbIds.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT record_id, action, performed_by, note, created_at FROM approval_history
     WHERE record_id IN (${placeholders}) ORDER BY id ASC`,
    recordDbIds
  );
  const grouped = {};
  rows.forEach((r) => {
    if (!grouped[r.record_id]) grouped[r.record_id] = [];
    grouped[r.record_id].push(r);
  });
  return grouped;
}

// scope narrows the result set for role-based visibility: drivers only see
// their own records ("My Fuel Requests"). Sirs and admins both see and can
// act on every request — there's no more "assigned sir" concept, any sir
// or admin can review/approve any request.
async function getAll(scope = {}) {
  const where = [];
  const params = [];
  if (scope.role === "driver") {
    where.push("r.driver_id = ?");
    params.push(scope.driverId || 0); // 0 never matches a real id — driver has no linked profile
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows] = await pool.query(`${SELECT_BASE} ${whereSql} ORDER BY r.id DESC`, params);
  const historyByRecordId = await getHistoryForIds(rows.map((r) => r.id));
  return rows.map((row) => rowToApi(row, historyByRecordId[row.id] || []));
}

// Resolves a driver's canonical name from their linked drivers.id — used to
// force-fill the `driver` field when a driver-role user creates/edits their
// own record, so they can never attribute a fuel request to someone else.
async function getDriverNameById(driverId) {
  if (!driverId) return null;
  const [[row]] = await pool.query("SELECT name FROM drivers WHERE id = ?", [driverId]);
  return row ? row.name : null;
}

async function getByCode(recordCode) {
  const [rows] = await pool.query(`${SELECT_BASE} WHERE r.record_code = ? LIMIT 1`, [recordCode]);
  if (!rows.length) return null;
  return rowToApi(rows[0], await getHistory(rows[0].id));
}

async function getRawByCode(recordCode) {
  const [rows] = await pool.query("SELECT * FROM fuel_records WHERE record_code = ? LIMIT 1", [recordCode]);
  return rows[0] || null;
}

async function addHistory(recordDbId, action, by, note = "") {
  await pool.query(
    "INSERT INTO approval_history (record_id, action, performed_by, note) VALUES (?, ?, ?, ?)",
    [recordDbId, action, by || "-", note]
  );
}

// Resolves human-entered names (driver/sir/fuel type) to their FK ids,
// throwing a clear 400 if one doesn't exist in the reference lists.
async function resolveRefs({ driver, sirName, fuelType }, { isDraft }) {
  const refs = {};

  const [[driverRow]] = await pool.query("SELECT id FROM drivers WHERE name = ?", [driver]);
  if (!driverRow) throw new ApiError(400, `Unknown driver "${driver}". Add it in Settings first.`);
  refs.driverId = driverRow.id;

  // Office Sir is no longer a field on the request form — any sir/admin can
  // review and approve any request, so there's nothing to assign. Only
  // resolved if a value happens to be present (e.g. an older client, or
  // historical data), never required.
  if (sirName) {
    const [[sirRow]] = await pool.query("SELECT id FROM office_sirs WHERE name = ?", [sirName]);
    if (!sirRow) throw new ApiError(400, `Unknown office sir "${sirName}". Add it in Settings first.`);
    refs.sirId = sirRow.id;
  }

  if (!isDraft || fuelType) {
    const [[fuelTypeRow]] = await pool.query("SELECT id FROM fuel_types WHERE name = ?", [fuelType]);
    if (!fuelTypeRow) throw new ApiError(400, `Unknown fuel type "${fuelType}". Add it in Settings first.`);
    refs.fuelTypeId = fuelTypeRow.id;
  }

  return refs;
}

async function findDuplicateReceipt(receiptNumber, excludeCode) {
  if (!receiptNumber) return null;
  const [rows] = await pool.query(
    "SELECT record_code FROM fuel_records WHERE LOWER(receipt_number) = LOWER(?) AND record_code != ? LIMIT 1",
    [receiptNumber, excludeCode || ""]
  );
  return rows[0] || null;
}

// Server-side mirror of the frontend's validateForm() — the frontend still
// validates first for instant feedback, but the API is the real gatekeeper.
function validatePayload(payload, { isDraft }) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (!payload.date) {
    payload.date = today;
  } else if (payload.date > today) {
    throw new ApiError(400, "Date cannot be in the future.");
  }

  // Time and Office Sir are no longer fields on the request form — time is
  // captured automatically (see nowTimeSql()), and any sir/admin can act on
  // any request now, so there's nothing to assign.
  const required = isDraft
    ? ["date", "driver", "vehicleNumber"]
    : ["date", "driver", "vehicleNumber", "fuelType"];

  for (const field of required) {
    if (!payload[field]) throw new ApiError(400, `${field} is required.`);
  }
  if (!isDraft && !(Number(payload.liters) > 0)) {
    throw new ApiError(400, "Fuel quantity must be greater than zero.");
  }
  if (payload.liters != null && Number(payload.liters) < 0) throw new ApiError(400, "Quantity cannot be negative.");
  if (payload.pricePerLiter != null && Number(payload.pricePerLiter) < 0) throw new ApiError(400, "Price cannot be negative.");
  if (payload.odometer != null && payload.odometer !== "" && Number(payload.odometer) < 0) {
    throw new ApiError(400, "Odometer cannot be negative.");
  }
}

// Fuel Machine Display Photo + Money Receipt Photo are mandatory for every
// non-draft fuel request — enforced here so the rule holds even if a
// request bypasses the client (curl, a bug, a future UI) entirely.
function requireMandatoryPhotos(fuelReceiptImage, moneyReceiptImage, isDraft) {
  if (isDraft) return;
  if (!fuelReceiptImage) throw new ApiError(400, "Fuel Machine Display Photo is required.");
  if (!moneyReceiptImage) throw new ApiError(400, "Money Receipt Photo is required.");
}

// Time is captured automatically at the moment of creation using the server's local clock
function nowTimeSql() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
}

async function create(payload, images, { isDraft, actorName }) {
  validatePayload(payload, { isDraft });
  requireMandatoryPhotos(images.fuelReceiptImage, images.moneyReceiptImage, isDraft);

  const dupe = await findDuplicateReceipt(payload.receiptNumber);
  if (dupe) throw new ApiError(409, `Receipt number already used in record ${dupe.record_code}.`);

  const refs = await resolveRefs(payload, { isDraft });
  const recordCode = await nextRecordCode(pool);
  const liters = Number(payload.liters) || 0;
  const price = Number(payload.pricePerLiter) || 0;
  const serverTime = nowTimeSql();

  const [result] = await pool.query(
    `INSERT INTO fuel_records
      (record_code, record_date, record_time, driver_id, sir_id, vehicle_number,
       station_name, odometer, fuel_type_id, liters, price_per_liter, total_amount,
       receipt_number, remarks, fuel_receipt_image, money_receipt_image,
       driver_photo_image, vehicle_photo_image, is_draft, approval_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      recordCode, payload.date, serverTime, refs.driverId, refs.sirId || null,
      payload.vehicleNumber, payload.stationName || null, payload.odometer || null,
      refs.fuelTypeId || null, liters, price, liters * price,
      payload.receiptNumber || null, payload.remarks || null,
      images.fuelReceiptImage || null, images.moneyReceiptImage || null,
      images.driverPhotoImage || null, images.vehiclePhotoImage || null,
      isDraft ? 1 : 0, isDraft ? "draft" : "pending",
    ]
  );

  await addHistory(result.insertId, isDraft ? "Saved as Draft" : "Created", actorName,
    isDraft ? "Fuel record saved as a draft." : "Fuel record created.");

  return getByCode(recordCode);
}

async function update(recordCode, payload, images, { isDraft, actorName }) {
  const original = await getRawByCode(recordCode);
  if (!original) throw new ApiError(404, "Record not found.");
  if (original.is_locked) throw new ApiError(423, "This record is locked. An administrator must unlock it before it can be edited.");

  validatePayload(payload, { isDraft });

  const dupe = await findDuplicateReceipt(payload.receiptNumber, recordCode);
  if (dupe) throw new ApiError(409, `Receipt number already used in record ${dupe.record_code}.`);

  const refs = await resolveRefs(payload, { isDraft });
  const liters = Number(payload.liters) || 0;
  const price = Number(payload.pricePerLiter) || 0;
  const totalAmount = liters * price;

  const current = await getByCode(recordCode); // API-shaped, for the sensitive-field diff below

  // Purely computes what an image field WOULD become — a newly uploaded
  // file wins, an explicit "remove<Field>=true" flag clears it, otherwise
  // it's untouched. No filesystem side effects here: we only delete the
  // old file once validation has passed and the DB write has succeeded
  // (see below) — otherwise a rejected request could leave a record
  // pointing at a file we already deleted.
  function resolveImageField(newPath, removeFlag, currentPath) {
    if (newPath) return newPath;
    if (removeFlag === "true") return null;
    return currentPath;
  }

  const newFuelReceiptImage = resolveImageField(images.fuelReceiptImage, payload.removeFuelReceiptImage, current.fuelReceiptImage);
  const newMoneyReceiptImage = resolveImageField(images.moneyReceiptImage, payload.removeMoneyReceiptImage, current.moneyReceiptImage);
  const newDriverPhotoImage = resolveImageField(images.driverPhotoImage, payload.removeDriverPhotoImage, current.driverPhotoImage);
  const newVehiclePhotoImage = resolveImageField(images.vehiclePhotoImage, payload.removeVehiclePhotoImage, current.vehiclePhotoImage);

  requireMandatoryPhotos(newFuelReceiptImage, newMoneyReceiptImage, isDraft);

  const candidate = {
    date: payload.date, driver: payload.driver, sirName: payload.sirName || current.sirName,
    vehicleNumber: payload.vehicleNumber, fuelType: payload.fuelType || current.fuelType,
    liters, pricePerLiter: price, totalAmount,
    receiptNumber: payload.receiptNumber || "", stationName: payload.stationName || "",
    odometer: payload.odometer || null,
    fuelReceiptImage: newFuelReceiptImage, moneyReceiptImage: newMoneyReceiptImage,
  };

  const wasDraft = !!original.is_draft;
  const wasApproved = original.approval_status === "approved";
  const sensitiveChanged = !wasDraft && wasApproved && APPROVAL_SENSITIVE_FIELDS.some(
    (f) => String(current[f] ?? "") !== String(candidate[f] ?? "")
  );

  let approvalStatus = original.approval_status;
  let approvedBy = original.approved_by;
  let approvedAt = original.approved_at;
  let signatureImage = original.signature_image;
  let machinePhotoReviewed = !!original.machine_photo_reviewed;
  let moneyReceiptReviewed = !!original.money_receipt_reviewed;
  let isLocked = !!original.is_locked;

  if (wasDraft && !isDraft) {
    approvalStatus = "pending";
    await addHistory(original.id, "Draft Completed", actorName, "Draft completed and submitted for review.");
  } else if (wasDraft && isDraft) {
    await addHistory(original.id, "Draft Updated", actorName, "Draft details were updated.");
  } else if (sensitiveChanged) {
    approvalStatus = "pending";
    approvedBy = null;
    approvedAt = null;
    signatureImage = null;
    machinePhotoReviewed = false;
    moneyReceiptReviewed = false;
    isLocked = false;
    await addHistory(original.id, "Approval Revoked", "System",
      "Record details were edited after approval; re-approval is required.");
  } else {
    isLocked = approvalStatus === "approved";
    await addHistory(original.id, "Edited", actorName, "Record details were updated.");
  }

  await pool.query(
    `UPDATE fuel_records SET
       record_date=?, record_time=?, driver_id=?, sir_id=?, vehicle_number=?,
       station_name=?, odometer=?, fuel_type_id=?, liters=?, price_per_liter=?, total_amount=?,
       receipt_number=?, remarks=?, fuel_receipt_image=?, money_receipt_image=?,
       driver_photo_image=?, vehicle_photo_image=?, is_draft=?, approval_status=?,
       approved_by=?, approved_at=?, signature_image=?,
       machine_photo_reviewed=?, money_receipt_reviewed=?, is_locked=?
     WHERE id=?`,
    [
      payload.date, payload.time || original.record_time, refs.driverId, refs.sirId || original.sir_id,
      payload.vehicleNumber, payload.stationName || null, payload.odometer || null,
      refs.fuelTypeId || original.fuel_type_id, liters, price, totalAmount,
      payload.receiptNumber || null, payload.remarks || null,
      newFuelReceiptImage, newMoneyReceiptImage, newDriverPhotoImage, newVehiclePhotoImage,
      isDraft ? 1 : 0, approvalStatus, approvedBy, approvedAt, signatureImage,
      machinePhotoReviewed ? 1 : 0, moneyReceiptReviewed ? 1 : 0, isLocked ? 1 : 0,
      original.id,
    ]
  );

  // Only now — after validation passed AND the DB write succeeded — clean
  // up any file that was actually replaced or removed, so a rejected
  // request never leaves a record pointing at a deleted file.
  if (images.fuelReceiptImage && current.fuelReceiptImage) deleteUploadedFile(current.fuelReceiptImage);
  if (images.moneyReceiptImage && current.moneyReceiptImage) deleteUploadedFile(current.moneyReceiptImage);
  if (images.driverPhotoImage && current.driverPhotoImage) deleteUploadedFile(current.driverPhotoImage);
  if (images.vehiclePhotoImage && current.vehiclePhotoImage) deleteUploadedFile(current.vehiclePhotoImage);
  if (!images.fuelReceiptImage && payload.removeFuelReceiptImage === "true" && current.fuelReceiptImage) deleteUploadedFile(current.fuelReceiptImage);
  if (!images.moneyReceiptImage && payload.removeMoneyReceiptImage === "true" && current.moneyReceiptImage) deleteUploadedFile(current.moneyReceiptImage);
  if (!images.driverPhotoImage && payload.removeDriverPhotoImage === "true" && current.driverPhotoImage) deleteUploadedFile(current.driverPhotoImage);
  if (!images.vehiclePhotoImage && payload.removeVehiclePhotoImage === "true" && current.vehiclePhotoImage) deleteUploadedFile(current.vehiclePhotoImage);

  return getByCode(recordCode);
}

async function remove(recordCode) {
  const original = await getRawByCode(recordCode);
  if (!original) throw new ApiError(404, "Record not found.");
  await pool.query("DELETE FROM fuel_records WHERE id = ?", [original.id]);
  return original; // caller uses this to clean up uploaded files
}

// Marks ONE of the two mandatory photos as reviewed by the sir. The
// Approve & Sign gate (below) only opens once BOTH have been marked —
// see the derived `reviewedForApproval` in rowToApi().
async function markImageReviewed(recordCode, target, actorName) {
  if (!["machine", "money"].includes(target)) {
    throw new ApiError(400, 'image target must be "machine" or "money".');
  }
  const original = await getRawByCode(recordCode);
  if (!original) throw new ApiError(404, "Record not found.");

  const column = target === "machine" ? "machine_photo_reviewed" : "money_receipt_reviewed";
  const alreadyReviewed = target === "machine" ? original.machine_photo_reviewed : original.money_receipt_reviewed;

  if (original.approval_status === "pending" && !alreadyReviewed) {
    await pool.query(`UPDATE fuel_records SET ${column} = 1 WHERE id = ?`, [original.id]);
    await addHistory(
      original.id,
      target === "machine" ? "Machine Photo Reviewed" : "Money Receipt Reviewed",
      actorName,
      target === "machine"
        ? "Sir reviewed the fuel machine display photo."
        : "Sir reviewed the money receipt photo."
    );
  }
  return getByCode(recordCode);
}

async function approve(recordCode, { approverName, officeRemarks }, signatureImagePath) {
  const original = await getRawByCode(recordCode);
  if (!original) throw new ApiError(404, "Record not found.");
  if (original.is_draft) throw new ApiError(400, "A draft must be completed before it can be approved.");
  if (!original.machine_photo_reviewed || !original.money_receipt_reviewed) {
    throw new ApiError(400, "Please review both the Fuel Machine Display Photo and the Money Receipt Photo before approving.");
  }
  if (!approverName) throw new ApiError(400, "Approver name is required.");
  if (!signatureImagePath) throw new ApiError(400, "A signature is required.");

  await pool.query(
    `UPDATE fuel_records SET
       approval_status='approved', approved_by=?, approved_at=NOW(),
       signature_image=?, office_remarks=?, is_locked=1
     WHERE id=?`,
    [approverName, signatureImagePath, officeRemarks || null, original.id]
  );
  await addHistory(original.id, "Approved & Signed", approverName, "Record reviewed and signed off.");
  return getByCode(recordCode);
}

async function unlock(recordCode, actorName) {
  const original = await getRawByCode(recordCode);
  if (!original) throw new ApiError(404, "Record not found.");
  await pool.query("UPDATE fuel_records SET is_locked = 0 WHERE id = ?", [original.id]);
  await addHistory(original.id, "Unlocked", actorName, "Record manually unlocked by an administrator for editing.");
  return getByCode(recordCode);
}

async function setFuelStatus(recordCode, status, actorName) {
  if (!["received", "not_received"].includes(status)) throw new ApiError(400, "Invalid fuel status.");
  const original = await getRawByCode(recordCode);
  if (!original) throw new ApiError(404, "Record not found.");
  if (original.is_draft) throw new ApiError(400, "Draft records cannot have a fuel status set until submitted.");

  await pool.query("UPDATE fuel_records SET fuel_received = ? WHERE id = ?", [status, original.id]);
  await addHistory(
    original.id,
    status === "received" ? "Fuel Received" : "Fuel Not Received",
    actorName,
    status === "received" ? "Sir confirmed fuel was received." : "Sir confirmed fuel was NOT received."
  );
  return getByCode(recordCode);
}

// Photo retention: every fuel record's photos (both mandatory photos, the
// two optional ones, and the sir's signature) are only kept for 3 months
// from the record's creation date — after that they're deleted from disk
// and their DB columns cleared. Nothing else about the record changes: the
// Evidence photos (Fuel Machine, Money Receipt, Dashboard/Odometer) are subject
// to automatic 90-day retention purging. Driver profile photos and Digital
// Signatures are EXEMPT from automatic purging.
const EVIDENCE_PHOTO_COLUMNS = [
  "fuel_receipt_image",
  "money_receipt_image",
  "vehicle_photo_image",
];

const PHOTO_FIELD_MAP = {
  fuelReceipt: { col: "fuel_receipt_image", label: "Fuel Machine Photo" },
  moneyReceipt: { col: "money_receipt_image", label: "Money Receipt Photo" },
  vehiclePhoto: { col: "vehicle_photo_image", label: "Dashboard/Odometer Photo" },
  driverPhoto: { col: "driver_photo_image", label: "Driver Photo" },
  signature: { col: "signature_image", label: "Digital Signature" },
};

async function purgeExpiredPhotos() {
  const [rows] = await pool.query(
    `SELECT id, record_code, ${EVIDENCE_PHOTO_COLUMNS.join(", ")} FROM fuel_records
     WHERE created_at < (NOW() - INTERVAL 90 DAY)
       AND (${EVIDENCE_PHOTO_COLUMNS.map((c) => `${c} IS NOT NULL`).join(" OR ")})`
  );
  if (!rows.length) return { recordsPurged: 0, filesDeleted: 0 };

  let filesDeleted = 0;
  for (const row of rows) {
    const columnsToNull = [];
    const purgedTypes = [];
    for (const col of EVIDENCE_PHOTO_COLUMNS) {
      if (row[col]) {
        deleteUploadedFile(row[col]);
        filesDeleted++;
        columnsToNull.push(`${col} = NULL`);
        if (col === "fuel_receipt_image") purgedTypes.push("Fuel Machine Photo");
        if (col === "money_receipt_image") purgedTypes.push("Money Receipt Photo");
        if (col === "vehicle_photo_image") purgedTypes.push("Dashboard/Odometer Photo");
      }
    }
    if (columnsToNull.length) {
      await pool.query(`UPDATE fuel_records SET ${columnsToNull.join(", ")} WHERE id = ?`, [row.id]);
      await addHistory(
        row.id,
        "Photo Retention Purge",
        "System",
        "📷 Photo evidence has been removed according to the 90-day retention policy."
      );
    }
  }

  return { recordsPurged: rows.length, filesDeleted };
}

async function deleteRecordPhoto(recordCode, photoType, adminUsername, reason = "") {
  const config = PHOTO_FIELD_MAP[photoType];
  if (!config) throw new ApiError(400, "Invalid photo type.");

  const [rows] = await pool.query(
    `SELECT id, record_code, ${config.col} FROM fuel_records WHERE record_code = ? LIMIT 1`,
    [recordCode]
  );
  if (!rows.length) throw new ApiError(404, "Record not found.");

  const record = rows[0];
  const photoPath = record[config.col];
  if (!photoPath) throw new ApiError(400, `${config.label} is already empty or deleted.`);

  deleteUploadedFile(photoPath);
  await pool.query(`UPDATE fuel_records SET ${config.col} = NULL WHERE id = ?`, [record.id]);

  const note = `Admin "${adminUsername}" manually deleted ${config.label}.${reason ? ` Reason: ${reason}` : ""}`;
  await addHistory(record.id, `${config.label} Deleted`, adminUsername, note);

  return getByCode(recordCode);
}

async function getDriverPhoto(driverId, driverName) {
  if (driverId) {
    const [[row]] = await pool.query(
      `SELECT u.profile_photo, d.photo_path
       FROM users u
       LEFT JOIN drivers d ON d.id = u.driver_id
       WHERE u.driver_id = ? OR u.id = ? LIMIT 1`,
      [driverId, driverId]
    );
    if (row && (row.profile_photo || row.photo_path)) return row.profile_photo || row.photo_path;
  }
  if (driverName) {
    const [[row]] = await pool.query(
      `SELECT u.profile_photo, d.photo_path
       FROM drivers d
       LEFT JOIN users u ON u.driver_id = d.id
       WHERE d.name = ? LIMIT 1`,
      [driverName]
    );
    if (row && (row.profile_photo || row.photo_path)) return row.profile_photo || row.photo_path;
  }
  return null;
}

module.exports = {
  getAll, getByCode, getRawByCode, getDriverNameById, getDriverPhoto, create, update, remove,
  markImageReviewed, approve, unlock, setFuelStatus, purgeExpiredPhotos, deleteRecordPhoto,
};
