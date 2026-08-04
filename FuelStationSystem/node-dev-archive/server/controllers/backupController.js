const asyncHandler = require("../utils/asyncHandler");
const backupModel = require("../models/backupModel");

const exportBackup = asyncHandler(async (req, res) => {
  const backup = await backupModel.exportBackup();
  res.json({ success: true, data: backup });
});

const importBackup = asyncHandler(async (req, res) => {
  await backupModel.importBackup(req.body);
  res.json({ success: true, message: "Backup restored successfully." });
});

const clearAllData = asyncHandler(async (req, res) => {
  await backupModel.clearAllData();
  res.json({ success: true, message: "All data cleared." });
});

module.exports = { exportBackup, importBackup, clearAllData };
