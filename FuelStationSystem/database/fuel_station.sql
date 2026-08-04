-- ============================================================
-- Fuel Station Management System — MySQL Schema
-- ============================================================
-- Run this once against a MySQL 8+ server to create the database,
-- tables, indexes, foreign keys, and starter reference data.
--
--   mysql -u root -p < database/fuel_station.sql
--
-- NOTE ON USERS: the initial admin login account is seeded
-- automatically by the server on first boot (see server/config/seed.js)
-- using bcrypt at runtime and the SEED_ADMIN_* values in your .env —
-- not baked into this file — so the password hash is never frozen
-- into version control. This file seeds everything else.
-- ============================================================

CREATE DATABASE IF NOT EXISTS fuel_station
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE fuel_station;

-- ------------------------------------------------------------
-- users — login accounts (Admin / Sir-Manager / Driver)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username       VARCHAR(50)  NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  full_name      VARCHAR(100) NOT NULL,
  role           ENUM('admin', 'sir', 'driver') NOT NULL DEFAULT 'driver',
  driver_id      INT UNSIGNED NULL,   -- optional link if this login belongs to a specific driver
  sir_id         INT UNSIGNED NULL,   -- optional link if this login belongs to a specific office sir
  phone          VARCHAR(30)  NULL,
  email          VARCHAR(150) NULL,
  employee_id    VARCHAR(50)  NULL,
  profile_photo  VARCHAR(255) NULL,
  last_login_at  DATETIME     NULL,
  password_changed_at DATETIME NULL,
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,   -- Status: Active / Inactive
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_employee_id (employee_id),
  UNIQUE KEY uq_users_phone (phone),
  -- Prevents two login accounts from ever being linked to the same driver/
  -- sir profile (MySQL allows multiple NULLs through a UNIQUE index, so
  -- admin/unlinked accounts are unaffected).
  UNIQUE KEY uq_users_driver_id (driver_id),
  UNIQUE KEY uq_users_sir_id (sir_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- drivers — reference list of drivers (used in the record form)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drivers (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                  VARCHAR(100) NOT NULL,
  photo_path            VARCHAR(255) NULL,
  vehicle_numbers       JSON NULL,             -- e.g. ["DHAKA-METRO-GA-1234", "DHAKA-METRO-KHA-5678"]
  default_fuel_type_id  INT UNSIGNED NULL,     -- FK added below, once fuel_types exists
  is_active             TINYINT(1)   NOT NULL DEFAULT 1,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_drivers_name (name)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- office_sirs — reference list of office sirs / approvers
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS office_sirs (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  department   VARCHAR(100) NULL,
  designation  VARCHAR(100) NULL,
  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sirs_name (name)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- fuel_types — configurable fuel type list (Settings page)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fuel_types (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(50) NOT NULL,
  created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fuel_types_name (name)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- stations — configurable fuel station list (Settings page)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stations (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(150) NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stations_name (name)
) ENGINE=InnoDB;

-- Now add the FKs from users -> drivers/office_sirs, and drivers ->
-- fuel_types (added after all referenced tables exist to avoid ordering issues).
ALTER TABLE users
  ADD CONSTRAINT fk_users_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_users_sir    FOREIGN KEY (sir_id)    REFERENCES office_sirs(id) ON DELETE SET NULL;

ALTER TABLE drivers
  ADD CONSTRAINT fk_drivers_default_fuel_type FOREIGN KEY (default_fuel_type_id) REFERENCES fuel_types(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- fuel_records — the core record, one row per fuel collection
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fuel_records (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  record_code           VARCHAR(20)  NOT NULL,             -- e.g. FS-0001
  record_date           DATE         NOT NULL,
  record_time           TIME         NOT NULL,
  driver_id             INT UNSIGNED NOT NULL,
  sir_id                INT UNSIGNED NULL,        -- nullable: a draft can be saved before a sir is chosen
  vehicle_number        VARCHAR(50)  NOT NULL,
  station_name          VARCHAR(150) NULL,
  odometer              INT UNSIGNED NULL,
  fuel_type_id          INT UNSIGNED NULL,         -- nullable: a draft can be saved before a fuel type is chosen
  liters                DECIMAL(10,2) NOT NULL DEFAULT 0,
  price_per_liter       DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_amount          DECIMAL(12,2) NOT NULL DEFAULT 0,
  receipt_number        VARCHAR(50)  NULL,
  remarks               TEXT NULL,                          -- driver's remarks
  office_remarks        TEXT NULL,                           -- sir's remarks, added at approval time

  fuel_receipt_image    VARCHAR(255) NULL,                   -- "Fuel Machine Display Photo" in the UI (liters/price/total on the pump's display)
  money_receipt_image   VARCHAR(255) NULL,                   -- "Money Receipt Photo" in the UI (cash memo from the station)
  driver_photo_image    VARCHAR(255) NULL,
  vehicle_photo_image   VARCHAR(255) NULL,
  signature_image       VARCHAR(255) NULL,

  is_draft                TINYINT(1) NOT NULL DEFAULT 0,
  machine_photo_reviewed  TINYINT(1) NOT NULL DEFAULT 0,     -- sir explicitly marked the machine display photo as reviewed
  money_receipt_reviewed  TINYINT(1) NOT NULL DEFAULT 0,     -- sir explicitly marked the money receipt photo as reviewed
  approval_status       ENUM('draft', 'pending', 'approved') NOT NULL DEFAULT 'pending',
  approved_by           VARCHAR(100) NULL,
  approved_at           DATETIME NULL,
  is_locked             TINYINT(1) NOT NULL DEFAULT 0,        -- true once approved; requires admin unlock to edit
  fuel_received         ENUM('received', 'not_received') NULL,

  created_by            INT UNSIGNED NULL,                    -- user who created the record
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_fuel_records_code (record_code),

  CONSTRAINT fk_records_driver     FOREIGN KEY (driver_id)    REFERENCES drivers(id),
  CONSTRAINT fk_records_sir        FOREIGN KEY (sir_id)       REFERENCES office_sirs(id),
  CONSTRAINT fk_records_fuel_type  FOREIGN KEY (fuel_type_id) REFERENCES fuel_types(id),
  CONSTRAINT fk_records_created_by FOREIGN KEY (created_by)   REFERENCES users(id) ON DELETE SET NULL,

  INDEX idx_records_date (record_date),
  INDEX idx_records_driver (driver_id),
  INDEX idx_records_sir (sir_id),
  INDEX idx_records_fuel_type (fuel_type_id),
  INDEX idx_records_status (approval_status),
  INDEX idx_records_draft (is_draft),
  INDEX idx_records_receipt (receipt_number),
  INDEX idx_records_vehicle (vehicle_number),
  INDEX idx_records_station (station_name)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- approval_history — full audit trail per record (the timeline
-- shown in "View Details")
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_history (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  record_id     INT UNSIGNED NOT NULL,
  action        VARCHAR(50)  NOT NULL,   -- Created, Edited, Approved & Signed, Approval Revoked, Unlocked, ...
  performed_by  VARCHAR(100) NOT NULL,
  note          TEXT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_history_record FOREIGN KEY (record_id) REFERENCES fuel_records(id) ON DELETE CASCADE,
  INDEX idx_history_record (record_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- user_audit_logs — audit trail for profile and security changes
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- settings — single-row office configuration (name/logo/currency/theme)
-- Not one of the 7 tables you listed, but the Settings API needs
-- somewhere to persist these — added as the natural 8th table.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id              TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
  office_name     VARCHAR(150) NOT NULL DEFAULT 'ATMABISWAS Fuel',
  logo_path       VARCHAR(255) NULL,
  currency_symbol VARCHAR(10)  NOT NULL DEFAULT '৳',
  theme           VARCHAR(10)  NOT NULL DEFAULT 'auto',
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_settings_single_row CHECK (id = 1)
) ENGINE=InnoDB;

-- ============================================================
-- SAMPLE / STARTER DATA
-- ============================================================

INSERT INTO drivers (name) VALUES
  ('Driver 1'), ('Driver 2'), ('Driver 3'), ('Driver 4'), ('Driver 5')
ON DUPLICATE KEY UPDATE name = name;

INSERT INTO office_sirs (name) VALUES
  ('Mr. Rahim'), ('Mr. Karim'), ('Mr. Hasan'), ('Mr. Alam')
ON DUPLICATE KEY UPDATE name = name;

INSERT INTO fuel_types (name) VALUES
  ('Octane'), ('Petrol'), ('Diesel')
ON DUPLICATE KEY UPDATE name = name;

INSERT INTO stations (name) VALUES
  ('Padma Filling Station'), ('Meghna Fuel Station')
ON DUPLICATE KEY UPDATE name = name;

INSERT INTO settings (id, office_name, currency_symbol, theme) VALUES
  (1, 'ATMABISWAS Fuel', '৳', 'auto')
ON DUPLICATE KEY UPDATE office_name = office_name;

-- Two example fuel records so the dashboard/reports aren't empty on first run.
-- (created_by is left NULL here since the seeded admin user doesn't exist yet
-- at the time this script runs — the server backfills nothing, this is just
-- sample data for you to explore or delete.)
INSERT INTO fuel_records
  (record_code, record_date, record_time, driver_id, sir_id, vehicle_number,
   station_name, odometer, fuel_type_id, liters, price_per_liter, total_amount,
   receipt_number, remarks, is_draft, machine_photo_reviewed, money_receipt_reviewed,
   approval_status, approved_by, approved_at, is_locked, fuel_received)
VALUES
  ('FS-0001', CURDATE(), '09:15:00',
   (SELECT id FROM drivers WHERE name = 'Driver 1'),
   (SELECT id FROM office_sirs WHERE name = 'Mr. Rahim'),
   'DHAKA-METRO-GA-1234', 'Padma Filling Station', 45210,
   (SELECT id FROM fuel_types WHERE name = 'Octane'),
   10.00, 130.00, 1300.00, 'RCP-2026-001', 'Sample approved record',
   0, 1, 1, 'approved', 'Mr. Rahim', NOW(), 1, 'received'),
  ('FS-0002', CURDATE(), '14:40:00',
   (SELECT id FROM drivers WHERE name = 'Driver 2'),
   (SELECT id FROM office_sirs WHERE name = 'Mr. Karim'),
   'DHAKA-METRO-KHA-5678', 'Meghna Fuel Station', 12088,
   (SELECT id FROM fuel_types WHERE name = 'Diesel'),
   8.50, 120.00, 1020.00, 'RCP-2026-002', 'Sample pending record',
   0, 0, 0, 'pending', NULL, NULL, 0, NULL)
ON DUPLICATE KEY UPDATE record_code = record_code;

INSERT INTO approval_history (record_id, action, performed_by, note)
SELECT id, 'Created', 'Driver 1', 'Fuel record created.' FROM fuel_records WHERE record_code = 'FS-0001';
INSERT INTO approval_history (record_id, action, performed_by, note)
SELECT id, 'Approved & Signed', 'Mr. Rahim', 'Record reviewed and signed off.' FROM fuel_records WHERE record_code = 'FS-0001';
INSERT INTO approval_history (record_id, action, performed_by, note)
SELECT id, 'Fuel Received', 'Mr. Rahim', 'Sir confirmed fuel was received.' FROM fuel_records WHERE record_code = 'FS-0001';
INSERT INTO approval_history (record_id, action, performed_by, note)
SELECT id, 'Created', 'Driver 2', 'Fuel record created.' FROM fuel_records WHERE record_code = 'FS-0002';
