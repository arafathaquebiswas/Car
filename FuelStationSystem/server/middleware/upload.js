const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const ApiError = require("../utils/ApiError");

// Maps each expected form field name to its own uploads subfolder, so
// fuel receipts, money receipts, driver/vehicle photos, signatures, and the
// office logo never mix together on disk.
const FIELD_FOLDERS = {
  fuelReceiptImage: "fuel-receipts",
  moneyReceiptImage: "money-receipts",
  driverPhotoImage: "driver-photos",
  vehiclePhotoImage: "vehicle-photos",
  signatureImage: "signatures",
  logo: "logo",
  profilePhoto: "profile-photos",
};

// The saved file's extension is derived from this map (keyed off the
// validated MIME type), never from the client-supplied original filename —
// otherwise a spoofed Content-Type that slips past fileFilter could still
// carry an attacker-chosen extension (e.g. "shell.php") onto disk.
const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const ALLOWED_MIME_TYPES = new Set(Object.keys(MIME_TO_EXT));
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 12) * 1024 * 1024;

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const folder = FIELD_FOLDERS[file.fieldname];
    if (!folder) return cb(new ApiError(400, `Unexpected file field: ${file.fieldname}`));
    cb(null, path.join(__dirname, "..", "uploads", folder));
  },
  filename(req, file, cb) {
    const ext = MIME_TO_EXT[file.mimetype] || ".jpg";
    const unique = Date.now() + "-" + crypto.randomBytes(6).toString("hex");
    cb(null, unique + ext);
  },
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(new ApiError(400, "Only JPG, JPEG, PNG, or WEBP images are allowed."));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 6 },
});

// Turns a saved multer file object into the relative path we store in MySQL
// (e.g. "/uploads/fuel-receipts/173..._ab12cd.jpg").
function toRelativePath(file) {
  if (!file) return null;
  const folder = FIELD_FOLDERS[file.fieldname];
  return `/uploads/${folder}/${file.filename}`;
}

module.exports = { upload, toRelativePath, FIELD_FOLDERS };
