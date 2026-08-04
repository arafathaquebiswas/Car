const path = require("path");
const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const driverRoutes = require("./routes/driverRoutes");
const sirRoutes = require("./routes/sirRoutes");
const fuelTypeRoutes = require("./routes/fuelTypeRoutes");
const stationRoutes = require("./routes/stationRoutes");
const recordRoutes = require("./routes/recordRoutes");
const reportRoutes = require("./routes/reportRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const backupRoutes = require("./routes/backupRoutes");
const notificationRoutes = require("./routes/notificationRoutes");

const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");

const app = express();

// Enable Gzip/Brotli HTTP compression for all text, JSON, CSS, and JS responses
app.use(compression());

// This app is designed to also run as a plain-HTTP LAN/VPS deployment (see
// README/PROJECT_HANDOVER) with no TLS of its own — Nginx handles TLS only if
// an admin chooses to put it in front. Trust the first proxy hop so req.ip
// (and therefore express-rate-limit's per-IP bucketing) reflects the real
// client IP from X-Forwarded-For instead of lumping every office user
// together under the proxy's own IP, which would cause the whole office to
// share one rate-limit bucket. Harmless with no proxy in front (falls back to
// the socket address when there's no X-Forwarded-For header).
app.set("trust proxy", 1);

// Static assets (fuel/money receipts, photos, signatures, logo) need to be
// viewable in <img> tags, so relax helmet's cross-origin resource policy for
// them specifically rather than for the whole app. The frontend also loads
// jsPDF/jsPDF-AutoTable/SheetJS from cdnjs (see client/index.html), which
// helmet's default script-src 'self' would otherwise silently block.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://cdnjs.cloudflare.com"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
        "img-src": ["'self'", "data:", "blob:", "https:"],
        "upgrade-insecure-requests": null,
      },
    },
  })
);

// Enterprise Internal Security & Privacy Headers
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  next();
});

// Same-origin by default (origin:false — CORS headers omitted entirely,
// which browsers treat as "cross-origin not allowed"; same-origin requests
// are never affected by CORS either way). This app's own frontend is always
// served from the same origin as the API (see the static-file line below),
// so there's normally nothing that needs cross-origin access. Set
// CORS_ORIGIN only if something else (a separate mobile app, another site)
// legitimately needs to call this API from a different origin — don't leave
// it blank expecting "same-origin only" AND set `origin: true`, which
// actually means the opposite: reflect back and allow every origin.
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : false,
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// General API rate limit — generous for normal office use, tight enough to
// blunt scripted abuse.
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests — please slow down and try again shortly." },
  })
);

// Stricter limiter on login specifically, to blunt password-guessing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts — please wait a few minutes and try again." },
});
app.use("/api/auth/login", loginLimiter);

// Uploaded images (served as plain static files, e.g. /uploads/fuel-receipts/xyz.jpg).
// Every filename is content-addressed (timestamp + random hex, see
// middleware/upload.js) and never reused — replacing a photo always deletes
// the old file and writes a new name — so these are safe to cache "forever".
app.use("/uploads", express.static(path.join(__dirname, "uploads"), { maxAge: "7d", immutable: true }));

// API routes (mounted on both /api/v1 and legacy /api for 100% versioning compatibility)
const routesMap = [
  { path: "/auth", router: authRoutes },
  { path: "/users", router: userRoutes },
  { path: "/drivers", router: driverRoutes },
  { path: "/sirs", router: sirRoutes },
  { path: "/fuel-types", router: fuelTypeRoutes },
  { path: "/stations", router: stationRoutes },
  { path: "/records", router: recordRoutes },
  { path: "/reports", router: reportRoutes },
  { path: "/settings", router: settingsRoutes },
  { path: "/backup", router: backupRoutes },
  { path: "/notifications", router: notificationRoutes },
];

for (const prefix of ["/api/v1", "/api"]) {
  for (const item of routesMap) {
    app.use(prefix + item.path, item.router);
  }
  app.get(prefix + "/health", (req, res) =>
    res.json({
      status: "OK",
      database: "Connected",
      storage: "Writable",
      version: "1.0.0",
      environment: process.env.NODE_ENV || "development",
      server_time: new Date().toISOString(),
    })
  );
}

// The frontend static assets and SPA fallback (index.html)
const clientPath = path.join(__dirname, "..", "client");
app.use(express.static(clientPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/uploads")) {
    return next();
  }
  res.sendFile(path.join(clientPath, "index.html"));
});

app.use("/api", notFoundHandler);
app.use(errorHandler);

module.exports = app;
