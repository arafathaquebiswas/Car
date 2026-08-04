const asyncHandler = require("../utils/asyncHandler");
const settingsModel = require("../models/settingsModel");
const userModel = require("../models/userModel");
const { toRelativePath } = require("../middleware/upload");
const { deleteUploadedFile } = require("../utils/fileCleanup");

const getSettings = asyncHandler(async (req, res) => {
  const settings = await settingsModel.get();
  res.json({ success: true, data: settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const fields = {};
  const body = req.body || {};

  if (body.officeName !== undefined) fields.officeName = body.officeName.trim();
  if (body.currency !== undefined) fields.currency = body.currency.trim();
  if (body.theme !== undefined) fields.theme = body.theme;

  if (body.companyName !== undefined) fields.companyName = body.companyName.trim();
  if (body.shortName !== undefined) fields.shortName = body.shortName.trim();
  if (body.address !== undefined) fields.address = body.address.trim();
  if (body.phone !== undefined) fields.phone = body.phone.trim();
  if (body.email !== undefined) fields.email = body.email.trim();
  if (body.website !== undefined) fields.website = body.website.trim();
  if (body.footerCopyright !== undefined) fields.footerCopyright = body.footerCopyright.trim();
  if (body.reportHeader !== undefined) fields.reportHeader = body.reportHeader.trim();
  if (body.printHeader !== undefined) fields.printHeader = body.printHeader.trim();
  if (body.printFooter !== undefined) fields.printFooter = body.printFooter.trim();

  const logoFile = req.files && req.files.logo && req.files.logo[0];
  if (logoFile) {
    const previous = await settingsModel.get();
    fields.logo = toRelativePath(logoFile);
    fields.companyLogo = fields.logo;
    if (previous.logo) deleteUploadedFile(previous.logo);
    await userModel.logAudit({
      userId: req.user.id,
      username: req.user.username,
      action: "Company Logo Changed",
      note: "Updated company logo image",
    });
  } else if (body.removeLogo === "true") {
    const previous = await settingsModel.get();
    if (previous.logo) deleteUploadedFile(previous.logo);
    fields.logo = null;
    fields.companyLogo = null;
  }

  const settings = await settingsModel.update(fields);

  await userModel.logAudit({
    userId: req.user.id,
    username: req.user.username,
    action: "Branding Settings Updated",
    note: "Updated system branding configurations",
  });

  res.json({ success: true, data: settings });
});

module.exports = { getSettings, updateSettings };
