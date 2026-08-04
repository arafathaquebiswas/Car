const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const recordModel = require("../models/recordModel");
const notificationModel = require("../models/notificationModel");
const { toRelativePath } = require("../middleware/upload");
const { deleteUploadedFile } = require("../utils/fileCleanup");

async function notifyDriverByName(driverName, notificationData) {
  if (!driverName) return;
  try {
    const [[user]] = await pool.query(
      `SELECT u.id FROM users u
       LEFT JOIN drivers d ON d.id = u.driver_id
       WHERE d.name = ? OR u.full_name = ? LIMIT 1`,
      [driverName, driverName]
    );
    if (user) {
      await notificationModel.create({
        recipientId: user.id,
        ...notificationData,
      });
    }
  } catch (err) {
    console.error("Failed to notify driver:", err.message);
  }
}

// Multer puts uploaded files on req.files as { fieldName: [file] } when using
// .fields([...]); this turns that into { fieldName: "/uploads/.../x.jpg" }.
function filesToImagePaths(files) {
  const out = {};
  if (!files) return out;
  for (const fieldName of Object.keys(files)) {
    out[fieldName] = toRelativePath(files[fieldName][0]);
  }
  return out;
}

// Enforces "Drivers only see their own requests" at the resource level too
// (not just on the list endpoint), so a driver can't reach another driver's
// request by guessing its record code. Sirs and admins can access any
// request — there's no "assigned sir" restriction.
function assertRecordAccess(user, rawRecord) {
  if (user.role === "driver" && rawRecord.driver_id !== user.driverId) {
    throw new ApiError(403, "You can only access your own fuel requests.");
  }
}

const getAll = asyncHandler(async (req, res) => {
  const records = await recordModel.getAll({ role: req.user.role, driverId: req.user.driverId });
  res.json({ success: true, data: records });
});

const getOne = asyncHandler(async (req, res) => {
  const raw = await recordModel.getRawByCode(req.params.code);
  if (!raw) throw new ApiError(404, "Record not found.");
  assertRecordAccess(req.user, raw);

  const record = await recordModel.getByCode(req.params.code);
  res.json({ success: true, data: record });
});

const create = asyncHandler(async (req, res) => {
  const isDraft = req.body.isDraft === "true" || req.body.isDraft === true;
  const images = filesToImagePaths(req.files);
  const payload = { ...req.body };

  // A driver can only ever create a record for themselves — their own name
  // (from the linked drivers row) always wins over whatever the client sent.
  if (req.user.role === "driver") {
    const ownName = await recordModel.getDriverNameById(req.user.driverId);
    if (!ownName) throw new ApiError(403, "Your account has no linked driver profile.");
    payload.driver = ownName;
  }

  // Driver photo is automatically populated from the driver's profile picture
  const autoDriverPhoto = await recordModel.getDriverPhoto(req.user.driverId || req.user.id, payload.driver);
  if (autoDriverPhoto) {
    images.driverPhotoImage = autoDriverPhoto;
  }

  const record = await recordModel.create(payload, images, {
    isDraft,
    actorName: req.user.username,
  });

  if (isDraft) {
    await notificationModel.create({
      recipientId: req.user.id,
      title: "Draft Saved Successfully",
      message: `Fuel Request draft ${record.id} saved successfully.`,
      type: "info",
      relatedRecordCode: record.id,
    });
  } else {
    await notificationModel.notifyUsersByRole(["sir", "admin"], {
      title: "Fuel Request Submitted",
      message: `⛽ Driver "${record.driver}" submitted Fuel Request ${record.id} successfully.`,
      type: "approval",
      relatedRecordCode: record.id,
    });
  }

  res.status(201).json({ success: true, data: record });
});

const update = asyncHandler(async (req, res) => {
  const raw = await recordModel.getRawByCode(req.params.code);
  if (!raw) throw new ApiError(404, "Record not found.");
  assertRecordAccess(req.user, raw);

  const isDraft = req.body.isDraft === "true" || req.body.isDraft === true;
  const images = filesToImagePaths(req.files);
  const payload = { ...req.body };

  if (req.user.role === "driver") {
    const ownName = await recordModel.getDriverNameById(req.user.driverId);
    if (!ownName) throw new ApiError(403, "Your account has no linked driver profile.");
    payload.driver = ownName;
  }

  const record = await recordModel.update(req.params.code, payload, images, {
    isDraft,
    actorName: req.user.username,
  });

  if (!isDraft) {
    await notificationModel.notifyUsersByRole(["sir", "admin"], {
      title: "Fuel Request Resubmitted",
      message: `⛽ Fuel Request ${record.id} has been corrected and resubmitted by "${record.driver}".`,
      type: "approval",
      relatedRecordCode: record.id,
    });
  }

  res.json({ success: true, data: record });
});

const remove = asyncHandler(async (req, res) => {
  const deleted = await recordModel.remove(req.params.code);
  // Clean up every image file that belonged to this record.
  [
    deleted.fuel_receipt_image, deleted.money_receipt_image,
    deleted.driver_photo_image, deleted.vehicle_photo_image, deleted.signature_image,
  ].forEach(deleteUploadedFile);
  res.json({ success: true, message: `Record ${deleted.record_code} deleted.` });
});

// body: { image: "machine" | "money" } — marks that ONE mandatory photo as
// reviewed; the sir must call this for both before approve() will allow signing.
const review = asyncHandler(async (req, res) => {
  const raw = await recordModel.getRawByCode(req.params.code);
  if (!raw) throw new ApiError(404, "Record not found.");
  assertRecordAccess(req.user, raw);

  const record = await recordModel.markImageReviewed(req.params.code, req.body.image, req.user.username);

  await notifyDriverByName(record.driver, {
    title: "Photos Reviewed",
    message: `Your uploaded evidence photos for Fuel Request ${record.id} have been reviewed by ${req.user.username}.`,
    type: "info",
    relatedRecordCode: record.id,
  });

  res.json({ success: true, data: record });
});

const approve = asyncHandler(async (req, res) => {
  const raw = await recordModel.getRawByCode(req.params.code);
  if (!raw) throw new ApiError(404, "Record not found.");
  assertRecordAccess(req.user, raw);

  const signatureFile = req.files && req.files.signatureImage && req.files.signatureImage[0];
  const signaturePath = signatureFile ? toRelativePath(signatureFile) : null;
  const record = await recordModel.approve(
    req.params.code,
    { approverName: req.body.approverName, officeRemarks: req.body.officeRemarks },
    signaturePath
  );

  await notifyDriverByName(record.driver, {
    title: "Fuel Request Approved",
    message: `✅ Your fuel request ${record.id} has been approved.`,
    type: "success",
    relatedRecordCode: record.id,
  });

  res.json({ success: true, data: record });
});

const unlock = asyncHandler(async (req, res) => {
  const record = await recordModel.unlock(req.params.code, req.user.username);

  await notifyDriverByName(record.driver, {
    title: "Fuel Request Unlocked",
    message: `🔓 Your request ${record.id} has been unlocked by the administrator.`,
    type: "warning",
    relatedRecordCode: record.id,
  });

  await notificationModel.notifyUsersByRole(["sir"], {
    title: "Fuel Request Unlocked",
    message: `🔓 Request ${record.id} was unlocked by Administrator "${req.user.username}".`,
    type: "warning",
    relatedRecordCode: record.id,
  });

  res.json({ success: true, data: record });
});

const setFuelStatus = asyncHandler(async (req, res) => {
  const raw = await recordModel.getRawByCode(req.params.code);
  if (!raw) throw new ApiError(404, "Record not found.");
  assertRecordAccess(req.user, raw);

  const record = await recordModel.setFuelStatus(req.params.code, req.body.status, req.user.username);
  res.json({ success: true, data: record });
});

const deletePhoto = asyncHandler(async (req, res) => {
  const { code, photoType } = req.params;
  const { reason } = req.body;
  const record = await recordModel.deleteRecordPhoto(code, photoType, req.user.username, reason);
  res.json({ success: true, message: "Photo deleted successfully.", data: record });
});

module.exports = { getAll, getOne, create, update, remove, review, approve, unlock, setFuelStatus, deletePhoto };
