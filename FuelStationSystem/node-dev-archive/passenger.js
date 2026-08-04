/**
 * Phusion Passenger Entry Point for Hostinger Shared Hosting
 *
 * Hostinger Node.js App Selector utilizes Phusion Passenger to serve Express apps.
 * Passenger requires an entry point file (passenger.js or app.js) that initializes
 * environment variables and starts/exports the application.
 */

const path = require("path");

// Load production environment variables from .env in project root
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Ensure NODE_ENV is set to production when running under Passenger
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

const app = require("./server/app");
const pool = require("./server/config/db");
const { initDatabase } = require("./server/config/dbInit");
const { seedAdminUser } = require("./server/config/seed");
const { logger } = require("./server/utils/logger");

const PORT = process.env.PORT || 4000;

async function bootstrapHostingerApp() {
  try {
    // Check DB connection
    await pool.query("SELECT 1");
    await initDatabase();
    await seedAdminUser();

    logger.info("Hostinger Node.js application initialized successfully.");
  } catch (err) {
    logger.error("Failed to initialize Hostinger Node.js application:", err);
  }
}

// Execute bootstrap
bootstrapHostingerApp();

// If Passenger passes a port or socket, listen on it. Otherwise export app.
if (process.env.PORT || typeof PhusionPassenger !== "undefined") {
  app.listen(PORT, () => {
    logger.info(`Hostinger Express server listening on port/socket: ${PORT}`);
  });
}

module.exports = app;
