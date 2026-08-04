const pool = require("./db");

async function initDatabase() {
  const conn = await pool.getConnection();
  try {
    // 1. Add password_changed_at to users table if missing
    const [cols] = await conn.query("SHOW COLUMNS FROM users LIKE 'password_changed_at'");
    if (cols.length === 0) {
      await conn.query("ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL AFTER last_login_at");
      console.log("Added column password_changed_at to users table.");
    }

    // 2. Ensure phone column has a unique key if not present
    const [indexes] = await conn.query("SHOW INDEX FROM users WHERE Column_name = 'phone'");
    if (indexes.length === 0) {
      // Remove any blank phone numbers or normalize if needed before adding unique key
      await conn.query("UPDATE users SET phone = NULL WHERE phone = ''");
      try {
        await conn.query("ALTER TABLE users ADD UNIQUE KEY uq_users_phone (phone)");
        console.log("Added UNIQUE constraint to users.phone.");
      } catch (err) {
        console.warn("Could not add uq_users_phone index:", err.message);
      }
    }

    // 3. Create user_audit_logs table if missing
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_audit_logs (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id       INT UNSIGNED NOT NULL,
        username      VARCHAR(50)  NOT NULL,
        action        VARCHAR(100) NOT NULL,
        ip_address    VARCHAR(45)  NULL,
        note          TEXT         NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_user_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user_audit_user (user_id),
        INDEX idx_user_audit_action (action)
      ) ENGINE=InnoDB;
    `);

    // 4. Create notifications table if missing
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        recipient_id         INT UNSIGNED NOT NULL,
        recipient_role       VARCHAR(20) NULL,
        title                VARCHAR(255) NOT NULL,
        message              TEXT NOT NULL,
        type                 VARCHAR(50) NOT NULL DEFAULT 'info',
        related_record_code  VARCHAR(50) NULL,
        is_read              TINYINT(1) NOT NULL DEFAULT 0,
        read_at              DATETIME NULL,
        created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_notif_user FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_notif_recipient (recipient_id, is_read),
        INDEX idx_notif_created (created_at)
      ) ENGINE=InnoDB;
    `);

    // 5. Create notification_preferences table if missing
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        user_id          INT UNSIGNED PRIMARY KEY,
        in_app           TINYINT(1) NOT NULL DEFAULT 1,
        browser_alerts   TINYINT(1) NOT NULL DEFAULT 1,
        email_alerts     TINYINT(1) NOT NULL DEFAULT 0,
        sms_alerts       TINYINT(1) NOT NULL DEFAULT 0,
        updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_notif_pref_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);

    // 6. Create driver_profiles table if missing
    await conn.query(`
      CREATE TABLE IF NOT EXISTS driver_profiles (
        user_id                  INT UNSIGNED PRIMARY KEY,
        dob                      DATE NULL,
        gender                   ENUM('male', 'female', 'other') NULL,
        blood_group              VARCHAR(10) NULL,
        permanent_address        TEXT NULL,
        present_address          TEXT NULL,
        emergency_contact_name   VARCHAR(100) NULL,
        emergency_contact_number VARCHAR(30) NULL,
        nid_number               VARCHAR(50) UNIQUE NULL,
        nid_front_image          VARCHAR(255) NULL,
        nid_back_image           VARCHAR(255) NULL,
        nid_issue_date           DATE NULL,
        nid_expiry_date          DATE NULL,
        license_number           VARCHAR(50) UNIQUE NULL,
        license_front_image      VARCHAR(255) NULL,
        license_back_image       VARCHAR(255) NULL,
        license_issue_date       DATE NULL,
        license_expiry_date      DATE NULL,
        license_category         VARCHAR(50) NULL,
        license_authority        VARCHAR(100) NULL,
        verification_status      ENUM('Pending Verification', 'Verified', 'Rejected', 'Expired Documents') NOT NULL DEFAULT 'Pending Verification',
        other_document_image     VARCHAR(255) NULL,
        created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_driver_prof_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB;
    `);

    // 7. Add company branding fields to settings table if missing
    const brandingCols = [
      { name: "company_name", type: "VARCHAR(150) NULL DEFAULT 'ATMABISWAS'" },
      { name: "short_name", type: "VARCHAR(50) NULL DEFAULT 'ATMABISWAS Fuel'" },
      { name: "company_logo", type: "VARCHAR(255) NULL" },
      { name: "address", type: "TEXT NULL" },
      { name: "phone", type: "VARCHAR(50) NULL" },
      { name: "email", type: "VARCHAR(150) NULL" },
      { name: "website", type: "VARCHAR(150) NULL DEFAULT 'atmabiswas.org'" },
      { name: "footer_copyright", type: "VARCHAR(255) NULL DEFAULT '© 2026 ATMABISWAS. All Rights Reserved. Powered by ATMABISWAS ICT'" },
      { name: "report_header", type: "TEXT NULL" },
      { name: "print_header", type: "TEXT NULL" },
      { name: "print_footer", type: "TEXT NULL" },
      { name: "favicon_path", type: "VARCHAR(255) NULL" }
    ];

    for (const col of brandingCols) {
      const [existing] = await conn.query(`SHOW COLUMNS FROM settings LIKE '${col.name}'`);
      if (existing.length === 0) {
        await conn.query(`ALTER TABLE settings ADD COLUMN ${col.name} ${col.type}`);
        console.log(`Added column ${col.name} to settings table.`);
      }
    }

  } catch (err) {
    console.error("Error initializing database schema:", err.message);
  } finally {
    conn.release();
  }
}

module.exports = { initDatabase };
