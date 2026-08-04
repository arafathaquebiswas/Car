const express = require("express");
const authController = require("../controllers/authController");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.post("/login", authController.login);
router.post("/logout", authController.logout);
router.get("/me", requireAuth, authController.me);
router.post("/register", requireAuth, requireRole("admin"), authController.register);

module.exports = router;
