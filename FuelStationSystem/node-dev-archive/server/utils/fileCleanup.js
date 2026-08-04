const fs = require("fs");
const path = require("path");

// Deletes a previously-uploaded file when it's replaced or its record is
// deleted, so /uploads doesn't accumulate orphaned images forever.
// `relativePath` is what's stored in the DB, e.g. "/uploads/fuel-receipts/abc.jpg".
function deleteUploadedFile(relativePath) {
  if (!relativePath) return;
  const absolute = path.join(__dirname, "..", relativePath.replace(/^\/+/, ""));
  fs.unlink(absolute, (err) => {
    if (err && err.code !== "ENOENT") {
      console.warn("Could not delete old upload:", absolute, err.message);
    }
  });
}

module.exports = { deleteUploadedFile };
