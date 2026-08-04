const express = require("express");
const { requireAuth } = require("../middleware/auth");
const notificationController = require("../controllers/notificationController");

const router = express.Router();

router.get("/", requireAuth, notificationController.list);
router.get("/unread-count", requireAuth, notificationController.getUnreadCount);
router.put("/read-all", requireAuth, notificationController.markAllAsRead);
router.put("/:id/read", requireAuth, notificationController.markAsRead);
router.delete("/read", requireAuth, notificationController.removeAllRead);
router.delete("/:id", requireAuth, notificationController.remove);
router.get("/preferences", requireAuth, notificationController.getPreferences);
router.put("/preferences", requireAuth, notificationController.updatePreferences);

module.exports = router;
