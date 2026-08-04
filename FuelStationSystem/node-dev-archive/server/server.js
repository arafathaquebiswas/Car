require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const app = require("./app");
const pool = require("./config/db");
const { seedAdminUser } = require("./config/seed");
const { initDatabase } = require("./config/dbInit");
const { startPhotoRetentionJob } = require("./utils/photoRetentionJob");
const { startNotificationScheduler } = require("./utils/notificationScheduler");

const PORT = process.env.PORT || 4000;

// Defense in depth for unattended production use: log instead of letting an
// unexpected error silently vanish (unhandledRejection) or crash the process
// with no trace of why (uncaughtException). A genuinely corrupted process
// state after an uncaughtException isn't safe to keep serving requests from,
// so that one still exits — but loudly, and only after logging — so a
// process manager (systemd/PM2, see PROJECT_HANDOVER.md) can restart it
// cleanly instead of it dying silently overnight.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception — restarting process:", err);
  process.exit(1);
});

async function start() {
  try {
    await pool.query("SELECT 1"); // fail fast with a clear message if MySQL isn't reachable
    await initDatabase();
    await seedAdminUser();

    const server = app.listen(PORT, () => {
      console.log(`Fuel Station Management System running at http://localhost:${PORT}`);
      startPhotoRetentionJob();
      startNotificationScheduler();
    });

    // systemd/PM2 send SIGTERM on `restart`/`stop` (e.g. during a deploy) —
    // without handling it, Node's default behavior just kills the process
    // immediately, potentially cutting off whichever request(s) were
    // in-flight at that exact moment. Stop accepting new connections, let
    // in-flight ones finish (up to a timeout), then close the MySQL pool
    // cleanly before exiting.
    function shutdown(signal) {
      console.log(`${signal} received — shutting down gracefully...`);
      const forceExitTimer = setTimeout(() => {
        console.error("Graceful shutdown timed out — forcing exit.");
        process.exit(1);
      }, 10000);
      forceExitTimer.unref();
      server.close(async () => {
        try {
          await pool.end();
        } catch (err) {
          console.error("Error closing MySQL pool:", err.message);
        }
        clearTimeout(forceExitTimer);
        process.exit(0);
      });
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    console.error("Failed to start server:", err.message);
    console.error("Check that MySQL is running and your .env DB_* values are correct.");
    process.exit(1);
  }
}

start();
