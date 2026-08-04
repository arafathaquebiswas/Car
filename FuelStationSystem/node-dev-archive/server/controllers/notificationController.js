const notificationModel = require("../models/notificationModel");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

const list = asyncHandler(async (req, res) => {
  const { limit, offset, type, isRead, is_read, search } = req.query;
  const result = await notificationModel.getUserNotifications(req.user.id, {
    limit,
    offset,
    type,
    isRead: isRead ?? is_read,
    search,
  });
  res.json({ success: true, data: result });
});

const getUnreadCount = asyncHandler(async (req, res) => {
  const unreadCount = await notificationModel.getUnreadCount(req.user.id);
  res.json({ success: true, unreadCount });
});

const markAsRead = asyncHandler(async (req, res) => {
  const notif = await notificationModel.markAsRead(req.params.id, req.user.id);
  if (!notif) throw new ApiError(404, "Notification not found.");
  res.json({ success: true, data: notif });
});

const markAllAsRead = asyncHandler(async (req, res) => {
  await notificationModel.markAllAsRead(req.user.id);
  res.json({ success: true, message: "All notifications marked as read." });
});

const remove = asyncHandler(async (req, res) => {
  const deleted = await notificationModel.deleteNotification(req.params.id, req.user.id);
  if (!deleted) throw new ApiError(404, "Notification not found.");
  res.json({ success: true, message: "Notification deleted." });
});

const removeAllRead = asyncHandler(async (req, res) => {
  const result = await notificationModel.deleteAllRead(req.user.id);
  res.json({ success: true, message: "Read notifications deleted.", data: result });
});

const getPreferences = asyncHandler(async (req, res) => {
  const prefs = await notificationModel.getPreferences(req.user.id);
  res.json({ success: true, data: prefs });
});

const updatePreferences = asyncHandler(async (req, res) => {
  const prefs = await notificationModel.updatePreferences(req.user.id, req.body);
  res.json({ success: true, message: "Preferences updated.", data: prefs });
});

module.exports = {
  list,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  remove,
  removeAllRead,
  getPreferences,
  updatePreferences,
};
