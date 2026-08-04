const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const settingsController = require("../controllers/settingsController");

const router = express.Router();
const logoField = upload.fields([{ name: "logo", maxCount: 1 }]);

router.get("/", requireAuth, settingsController.getSettings);
router.put("/", requireAuth, requireRole("admin"), logoField, settingsController.updateSettings);

module.exports = router;
