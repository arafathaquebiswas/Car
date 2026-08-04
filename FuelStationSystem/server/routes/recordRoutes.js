const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const recordController = require("../controllers/recordController");

const router = express.Router();

const recordImageFields = upload.fields([
  { name: "fuelReceiptImage", maxCount: 1 },
  { name: "moneyReceiptImage", maxCount: 1 },
  { name: "driverPhotoImage", maxCount: 1 },
  { name: "vehiclePhotoImage", maxCount: 1 },
]);
const signatureField = upload.fields([{ name: "signatureImage", maxCount: 1 }]);

// Any authenticated role can view/create/edit records (drivers create them,
// sirs review/approve them); only admins can delete or unlock.
router.get("/", requireAuth, recordController.getAll);
router.get("/:code", requireAuth, recordController.getOne);
router.post("/", requireAuth, recordImageFields, recordController.create);
router.put("/:code", requireAuth, recordImageFields, recordController.update);
router.delete("/:code", requireAuth, requireRole("admin"), recordController.remove);

// Marking a mandatory photo as reviewed is a sir's approval action, same
// role restriction as approve/fuel-status below.
router.post("/:code/review", requireAuth, requireRole("admin", "sir"), recordController.review);
router.post("/:code/approve", requireAuth, requireRole("admin", "sir"), signatureField, recordController.approve);
router.post("/:code/unlock", requireAuth, requireRole("admin"), recordController.unlock);
router.post("/:code/fuel-status", requireAuth, requireRole("admin", "sir"), recordController.setFuelStatus);
router.delete("/:code/photos/:photoType", requireAuth, requireRole("admin"), recordController.deletePhoto);

module.exports = router;
