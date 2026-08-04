const pool = require("../config/db");

// Category Types supported:
// 'success', 'warning', 'error', 'info', 'approval', 'rejection', 'reminder', 'system'

async function create({ recipientId, recipientRole = null, title, message, type = "info", relatedRecordCode = null }) {
  if (!recipientId || !title || !message) return null;

  // Check if in-app notifications are enabled for this user
  const [[pref]] = await pool.query(
    "SELECT in_app FROM notification_preferences WHERE user_id = ?",
    [recipientId]
  );
  if (pref && pref.in_app === 0) {
    return null; // Disabled by user preference
  }

  const [result] = await pool.query(
    `INSERT INTO notifications
      (recipient_id, recipient_role, title, message, type, related_record_code, is_read)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [recipientId, recipientRole, title, message, type, relatedRecordCode || null]
  );

  const [[row]] = await pool.query("SELECT * FROM notifications WHERE id = ?", [result.insertId]);
  return row;
}

async function notifyUsersByRole(roles = [], { title, message, type = "info", relatedRecordCode = null }) {
  if (!roles.length) return [];
  const roleList = Array.isArray(roles) ? roles : [roles];

  const placeholders = roleList.map(() => "?").join(",");
  const [users] = await pool.query(
    `SELECT id, role FROM users WHERE role IN (${placeholders}) AND is_active = 1`,
    roleList
  );

  const createdList = [];
  for (const user of users) {
    const notif = await create({
      recipientId: user.id,
      recipientRole: user.role,
      title,
      message,
      type,
      relatedRecordCode,
    });
    if (notif) createdList.push(notif);
  }
  return createdList;
}

async function getUserNotifications(userId, { limit = 20, offset = 0, type = null, isRead = null, search = "" } = {}) {
  const params = [userId];
  let where = "WHERE recipient_id = ?";

  if (type) {
    where += " AND type = ?";
    params.push(type);
  }
  if (isRead !== null && isRead !== undefined && isRead !== "") {
    where += " AND is_read = ?";
    params.push(Number(isRead) === 1 ? 1 : 0);
  }
  if (search && search.trim()) {
    where += " AND (title LIKE ? OR message LIKE ? OR related_record_code LIKE ?)";
    const q = `%${search.trim()}%`;
    params.push(q, q, q);
  }

  const countSql = `SELECT COUNT(*) AS total FROM notifications ${where}`;
  const [[{ total }]] = await pool.query(countSql, params);

  const dataSql = `
    SELECT id, recipient_id, recipient_role, title, message, type,
           related_record_code, is_read, read_at, created_at
    FROM notifications ${where}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  const [rows] = await pool.query(dataSql, params);
  return { notifications: rows, total, limit: Number(limit), offset: Number(offset) };
}

async function getUnreadCount(userId) {
  const [[row]] = await pool.query(
    "SELECT COUNT(*) AS unreadCount FROM notifications WHERE recipient_id = ? AND is_read = 0",
    [userId]
  );
  return row ? row.unreadCount : 0;
}

async function markAsRead(id, userId) {
  await pool.query(
    "UPDATE notifications SET is_read = 1, read_at = NOW() WHERE id = ? AND recipient_id = ?",
    [id, userId]
  );
  const [[row]] = await pool.query("SELECT * FROM notifications WHERE id = ?", [id]);
  return row;
}

async function markAllAsRead(userId) {
  await pool.query(
    "UPDATE notifications SET is_read = 1, read_at = NOW() WHERE recipient_id = ? AND is_read = 0",
    [userId]
  );
  return { success: true };
}

async function deleteNotification(id, userId) {
  const [result] = await pool.query(
    "DELETE FROM notifications WHERE id = ? AND recipient_id = ?",
    [id, userId]
  );
  return result.affectedRows > 0;
}

async function deleteAllRead(userId) {
  const [result] = await pool.query(
    "DELETE FROM notifications WHERE recipient_id = ? AND is_read = 1",
    [userId]
  );
  return { deletedCount: result.affectedRows };
}

async function getPreferences(userId) {
  const [[row]] = await pool.query(
    "SELECT in_app, browser_alerts, email_alerts, sms_alerts FROM notification_preferences WHERE user_id = ?",
    [userId]
  );
  if (row) return row;

  // Default preferences
  return { in_app: 1, browser_alerts: 1, email_alerts: 0, sms_alerts: 0 };
}

async function updatePreferences(userId, { inApp = 1, browserAlerts = 1, emailAlerts = 0, smsAlerts = 0 }) {
  await pool.query(
    `INSERT INTO notification_preferences (user_id, in_app, browser_alerts, email_alerts, sms_alerts)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       in_app = VALUES(in_app),
       browser_alerts = VALUES(browser_alerts),
       email_alerts = VALUES(email_alerts),
       sms_alerts = VALUES(sms_alerts)`,
    [userId, inApp ? 1 : 0, browserAlerts ? 1 : 0, emailAlerts ? 1 : 0, smsAlerts ? 1 : 0]
  );
  return getPreferences(userId);
}

module.exports = {
  create,
  notifyUsersByRole,
  getUserNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllRead,
  getPreferences,
  updatePreferences,
};
