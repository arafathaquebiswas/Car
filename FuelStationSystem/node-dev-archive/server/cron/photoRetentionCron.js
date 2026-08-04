/**
 * Standalone Photo Retention Cron Job for Hostinger Shared Hosting
 *
 * Can be scheduled in Hostinger hPanel Cron Jobs:
 * Command: node /home/uXXXXX/domains/atmabiswas.org/public_html/fuel/server/cron/photoRetentionCron.js
 * Schedule: Once daily at 00:00 (0 0 * * *)
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const pool = require("../config/db");
const recordModel = require("../models/recordModel");
const { logger } = require("../utils/logger");

async function executeCron() {
  logger.info("Starting scheduled Photo Retention Purge job...");
  try {
    const { recordsPurged, filesDeleted } = await recordModel.purgeExpiredPhotos();
    logger.info(`Photo Retention Purge completed. Records purged: ${recordsPurged}, Files deleted: ${filesDeleted}`);
  } catch (err) {
    logger.error("Photo Retention Purge job encountered an error:", err);
  } finally {
    try {
      await pool.end();
    } catch (e) {
      // Ignore pool close errors
    }
    process.exit(0);
  }
}

executeCron();
