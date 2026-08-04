const express = require("express");
const { requireAuth } = require("../middleware/auth");
const reportController = require("../controllers/reportController");

const router = express.Router();

router.get("/", requireAuth, reportController.getReport);

module.exports = router;
