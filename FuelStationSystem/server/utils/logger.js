const fs = require("fs");
const path = require("path");

const LOGS_DIR = path.join(__dirname, "..", "..", "logs");

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const errorLogStream = fs.createWriteStream(path.join(LOGS_DIR, "error.log"), { flags: "a" });
const appLogStream = fs.createWriteStream(path.join(LOGS_DIR, "app.log"), { flags: "a" });

function formatLogMessage(level, message, meta) {
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] [${level.toUpperCase()}]: ${message}`;
  if (meta) {
    if (meta instanceof Error) {
      logLine += `\nStack: ${meta.stack}`;
    } else {
      logLine += ` ${JSON.stringify(meta)}`;
    }
  }
  return logLine + "\n";
}

const logger = {
  info(message, meta) {
    const formatted = formatLogMessage("info", message, meta);
    if (process.env.NODE_ENV !== "production") {
      console.log(formatted.trim());
    }
    appLogStream.write(formatted);
  },

  warn(message, meta) {
    const formatted = formatLogMessage("warn", message, meta);
    console.warn(formatted.trim());
    appLogStream.write(formatted);
  },

  error(message, meta) {
    const formatted = formatLogMessage("error", message, meta);
    console.error(formatted.trim());
    errorLogStream.write(formatted);
    appLogStream.write(formatted);
  },
};

module.exports = { logger };
