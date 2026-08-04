const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const backupController = require("../controllers/backupController");

const router = express.Router();

router.get("/export", requireAuth, requireRole("admin"), backupController.exportBackup);
router.post("/import", requireAuth, requireRole("admin"), backupController.importBackup);
router.delete("/clear-all", requireAuth, requireRole("admin"), backupController.clearAllData);

module.exports = router;
