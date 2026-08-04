/**
 * Database Migration & Optimization Script for Production Deployments
 *
 * Runs non-destructive schema migrations and verifies index optimization.
 * Safe to execute on every deployment step.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const pool = require("../config/db");
const { initDatabase } = require("../config/dbInit");
const { logger } = require("../utils/logger");

async function runMigration() {
  logger.info("Running database migration and index verification...");
  try {
    // 1. Initialize schema tables safely (CREATE TABLE IF NOT EXISTS)
    await initDatabase();

    // 2. Verify critical indexes for query performance
    const indexesToCheck = [
      { table: "fuel_records", index: "idx_records_date", col: "record_date" },
      { table: "fuel_records", index: "idx_records_status", col: "approval_status" },
      { table: "fuel_records", index: "idx_records_driver", col: "driver_id" },
      { table: "approval_history", index: "idx_history_record", col: "record_id" },
    ];

    for (const item of indexesToCheck) {
      const [rows] = await pool.query(
        `SHOW INDEX FROM ${item.table} WHERE Key_name = ?`,
        [item.index]
      );
      if (rows.length === 0) {
        logger.info(`Adding missing index ${item.index} to ${item.table}...`);
        await pool.query(`ALTER TABLE ${item.table} ADD INDEX ${item.index} (${item.col})`);
      }
    }

    logger.info("Database migration finished successfully.");
  } catch (err) {
    logger.error("Database migration error:", err);
    process.exit(1);
  } finally {
    try {
      await pool.end();
    } catch (e) {}
  }
}

runMigration();
