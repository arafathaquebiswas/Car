const asyncHandler = require("../utils/asyncHandler");
const reportModel = require("../models/reportModel");

const getReport = asyncHandler(async (req, res) => {
  const report = await reportModel.getReport(req.query);
  res.json({ success: true, data: report });
});

module.exports = { getReport };
