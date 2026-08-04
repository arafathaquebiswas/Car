const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createSimpleListModel } = require("../models/simpleListModel");
const { createSimpleListController } = require("../controllers/simpleListController");

const sirModel = createSimpleListModel("office_sirs");
const controller = createSimpleListController(sirModel, "Office sir");

const router = express.Router();

router.get("/", requireAuth, controller.getAll);
router.post("/", requireAuth, requireRole("admin"), controller.create);
router.delete("/:id", requireAuth, requireRole("admin"), controller.remove);

module.exports = router;
