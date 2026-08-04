const pool = require("../config/db");
const notificationModel = require("../models/notificationModel");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 45 * 1000; // Let server finish booting

async function runDailyScheduler() {
  try {
    // 1. Daily Pending Requests Summary
    const [[{ pendingCount }]] = await pool.query(
      "SELECT COUNT(*) AS pendingCount FROM fuel_records WHERE approval_status = 'pending'"
    );

    if (pendingCount > 0) {
      await notificationModel.notifyUsersByRole(["sir", "admin"], {
        title: "Daily Pending Requests Reminder",
        message: `There are ${pendingCount} pending fuel request(s) awaiting review and approval.`,
        type: "reminder",
      });
    }

    // 2. 24h Pending Request Escalation to Sirs
    const [pending24h] = await pool.query(
      `SELECT r.record_code, u.full_name AS driver
       FROM fuel_records r
       JOIN users u ON r.driver_id = u.id
       WHERE r.approval_status = 'pending'
         AND r.created_at <= (NOW() - INTERVAL 24 HOUR)
         AND r.created_at > (NOW() - INTERVAL 48 HOUR)`
    );
    for (const r of pending24h) {
      await notificationModel.notifyUsersByRole(["sir"], {
        title: "Pending Request Escalation (24h)",
        message: `Fuel Request ${r.record_code} submitted by "${r.driver}" has been pending for over 24 hours.`,
        type: "warning",
        relatedRecordCode: r.record_code,
      });
    }

    // 3. 48h Urgent Pending Request Escalation to Admins & Sirs
    const [pending48h] = await pool.query(
      `SELECT r.record_code, u.full_name AS driver
       FROM fuel_records r
       JOIN users u ON r.driver_id = u.id
       WHERE r.approval_status = 'pending'
         AND r.created_at <= (NOW() - INTERVAL 48 HOUR)`
    );
    for (const r of pending48h) {
      await notificationModel.notifyUsersByRole(["sir", "admin"], {
        title: "Urgent Escalation Alert (48h)",
        message: `CRITICAL: Fuel Request ${r.record_code} submitted by "${r.driver}" has been pending for over 48 hours! Urgent review required.`,
        type: "error",
        relatedRecordCode: r.record_code,
      });
    }

    // 4. Driver Document Expiry Reminders (Driving License)
    const [expiringDocs] = await pool.query(
      `SELECT dp.user_id, u.full_name, dp.license_number, dp.license_expiry_date,
              DATEDIFF(dp.license_expiry_date, CURDATE()) AS days_left
       FROM driver_profiles dp
       JOIN users u ON dp.user_id = u.id
       WHERE dp.license_expiry_date IS NOT NULL`
    );

    for (const doc of expiringDocs) {
      const days = doc.days_left;
      let title = null;
      let message = null;
      let type = "warning";

      if (days === 90 || days === 30 || days === 15 || days === 7 || days === 1) {
        title = `Driving License Expiring in ${days} Day(s)`;
        message = `Driver "${doc.full_name}"'s Driving License (${doc.license_number || 'N/A'}) expires in ${days} day(s) on ${doc.license_expiry_date}. Please arrange renewal.`;
      } else if (days <= 0) {
        title = `Driving License EXPIRED`;
        message = `CRITICAL: Driver "${doc.full_name}"'s Driving License (${doc.license_number || 'N/A'}) EXPIRED on ${doc.license_expiry_date}!`;
        type = "error";
        await pool.query(
          "UPDATE driver_profiles SET verification_status = 'Expired Documents' WHERE user_id = ?",
          [doc.user_id]
        );
      }

      if (title && message) {
        await notificationModel.notifyUsersByRole(["admin", "sir"], {
          title,
          message,
          type,
        });
        await notificationModel.create({
          recipientId: doc.user_id,
          recipientRole: "driver",
          title,
          message,
          type,
        });
      }
    }

  } catch (err) {
    console.error("Notification scheduler error:", err.message);
  }
}

function startNotificationScheduler() {
  setTimeout(() => {
    runDailyScheduler();
    setInterval(runDailyScheduler, ONE_DAY_MS);
  }, STARTUP_DELAY_MS);
}

module.exports = { startNotificationScheduler, runDailyScheduler };
