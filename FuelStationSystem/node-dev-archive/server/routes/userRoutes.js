const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const userController = require("../controllers/userController");

const router = express.Router();

const profilePhotoField = upload.single("profilePhoto");

const driverDocsUpload = upload.fields([
  { name: "profilePhoto", maxCount: 1 },
  { name: "nidFront", maxCount: 1 },
  { name: "nidBack", maxCount: 1 },
  { name: "licenseFront", maxCount: 1 },
  { name: "licenseBack", maxCount: 1 },
  { name: "otherDoc", maxCount: 1 },
]);

// Self-service routes are registered before the admin "/:id" routes so
// "/me" is never swallowed by the ":id" param pattern.
router.get("/me", requireAuth, userController.getMe);
router.get("/me/audit-logs", requireAuth, userController.getMyAuditLogs);
router.get("/me/driver-profile", requireAuth, userController.getDriverProfile);
router.put("/me/driver-profile", requireAuth, driverDocsUpload, userController.updateDriverProfile);
router.put("/me", requireAuth, profilePhotoField, userController.updateMe);
router.post("/me/change-password", requireAuth, userController.changePassword);

// Everything below is admin / sir management routes.
router.get("/", requireAuth, requireRole("admin"), userController.list);
router.get("/:id/driver-profile", requireAuth, userController.getDriverProfile);
router.put("/:id/driver-profile", requireAuth, driverDocsUpload, userController.updateDriverProfile);
router.put("/:id/verification-status", requireAuth, requireRole("admin", "sir"), userController.updateVerificationStatus);
router.get("/:id", requireAuth, requireRole("admin"), userController.getOne);
router.post("/", requireAuth, requireRole("admin"), profilePhotoField, userController.create);
router.put("/:id", requireAuth, requireRole("admin"), profilePhotoField, userController.update);
router.post("/:id/reset-password", requireAuth, requireRole("admin"), userController.resetPassword);
router.post("/:id/activate", requireAuth, requireRole("admin"), userController.activate);
router.post("/:id/deactivate", requireAuth, requireRole("admin"), userController.deactivate);
router.delete("/:id", requireAuth, requireRole("admin"), userController.remove);
router.delete("/:id/photo", requireAuth, requireRole("admin"), userController.deleteProfilePhoto);

module.exports = router;
