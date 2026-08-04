# Fuel Station Management System

A full-stack office fuel-request & approval system: **Node.js + Express + MySQL** backend, with the original vanilla HTML/CSS/JS frontend now talking to it over a REST API instead of LocalStorage.

Built for small office teams (3–5 drivers) to track fuel collection with the simplest possible workflow: a driver submits a request with two mandatory photos (fuel machine display + money receipt), any Sir or Admin reviews and approves it, and someone marks whether the fuel was actually received. Deliberately kept to the fewest fields, pages, and buttons needed for daily office use — no assignment step, no advanced settings, no charts to read.

## Folder Structure

```
FuelStationSystem/
├── client/                 Frontend (served as static files by the Express server)
│   ├── index.html
│   ├── style.css
│   ├── api.js               fetch() wrapper around the REST API
│   └── script.js            All UI logic, rendering, and workflow
├── server/                 Backend (Node.js + Express)
│   ├── config/               DB connection pool, first-run admin seeding
│   ├── controllers/           Request handlers
│   ├── middleware/            Auth (JWT), file upload (Multer), error handling
│   ├── models/                SQL queries (parameterized, mysql2)
│   ├── routes/                Express route definitions
│   ├── uploads/               Uploaded images live here (gitignored, kept via .gitkeep)
│   ├── utils/                  Small shared helpers
│   └── server.js              Entry point
├── database/
│   └── fuel_station.sql     Full schema + starter reference data
├── package.json
├── .env.example              Copy to .env and fill in your own values
└── README.md
```

## Requirements

- **Node.js** 18 or later
- **MySQL** 8 or later (or any MySQL-compatible server — MariaDB works too), running locally

## Setup — first time only

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in:

```
PORT=4000
NODE_ENV=development

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=            # your MySQL root (or app-user) password — blank if none
DB_NAME=fuel_station

JWT_SECRET=              # any long random string — e.g. run: openssl rand -hex 32
JWT_EXPIRES_IN=8h

SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=admin123
SEED_ADMIN_NAME=Administrator

MAX_UPLOAD_MB=12
CORS_ORIGIN=
```

The `SEED_ADMIN_*` values are only used **once** — the first time the server starts and finds an empty `users` table, it creates that admin account with a real bcrypt-hashed password. Change `SEED_ADMIN_PASSWORD` before that first run if you don't want to use `admin123`.

### 3. Create the database

Make sure MySQL is running, then:

```bash
mysql -u root -p < database/fuel_station.sql
```

(Drop the `-p` if your MySQL root user has no password.) This creates the `fuel_station` database, all 8 tables, foreign keys, indexes, and starter reference data (5 drivers, 4 office sirs, 3 fuel types, 2 sample fuel requests).

### 4. Start the server

```bash
npm start
```

You should see:

```
Seeded initial admin user "admin" (from .env SEED_ADMIN_* values).
Fuel Station Management System running at http://localhost:4000
```

(The "seeded" line only appears once, on the very first run.)

### 5. Open the app

Go to **http://localhost:4000** and log in with the admin account from your `.env` (default: `admin` / `admin123`).

For active development, `npm run dev` uses `nodemon` to auto-restart the server whenever a backend file changes (the frontend is plain static files — just refresh your browser after editing them, no restart needed).

## Roles & accounts

There are three roles: **Admin**, **Sir** (approver), and **Driver**. Only the seeded admin account exists at first. Log in as admin and go to **User Management** in the sidebar to create Sir/Driver logins — Full Name, Username, Password, Role, Phone, Email, Employee ID, and a profile photo are all set from that page (driver accounts additionally take vehicle number(s) and a default fuel type; sir accounts take department/designation). Admins can also reset passwords, activate/deactivate, and delete accounts from the same page.

The system is intentionally kept simple so drivers with little technical experience can use it without training — few fields, few buttons, no assignment step.

**What each role can do and see:**
- **Admin** — everything: User Management, manage drivers/sirs/fuel types/stations, branding/preferences, backup/restore, clear all data, delete requests, unlock locked (approved) requests, and **approve or sign any driver's fuel request** (no restriction to "assigned" requests). Nav: Dashboard, Add Fuel Request, All Requests, Reports, User Management, Settings, Profile.
- **Sir** — sees every fuel request in the system (not just ones addressed to them), reviews the two mandatory photos, approves & signs, adds remarks, and marks fuel received/not received on **any** request. Cannot delete users, change system settings, or back up/restore. Nav: Dashboard, All Requests, Reports, Profile.
- **Driver** — creates/edits only their own requests (until approved & locked) and saves drafts. Cannot approve or delete requests, access Settings, or see other drivers' requests — enforced both by hidden nav and by the API itself (`GET /api/records` and friends are scoped server-side to the requester's own driver profile). Nav: Dashboard, Add Fuel Request, My Fuel Requests, Profile.

Every role also gets a **Profile** page to view/edit their own contact info, photo, and password.

### The Fuel Request form

Kept to only the fields an office actually needs day to day: Date, Driver Name (auto-filled from login), Vehicle Number, Fuel Station, Fuel Type, Liters, Price per Liter, Total Amount (calculated automatically), the two mandatory photos below, and an optional Remarks field.

### Adding a photo to a fuel request

The two mandatory photos (Fuel Machine Display, Money Receipt) support both **📷 Open Camera** (live webcam preview on desktop; launches the phone's native camera app on Android/iPhone) and **📁 Choose from Gallery / Files**. A captured or chosen photo always shows a preview with **Retake**/**Replace**/**Remove** before it's attached — nothing is submitted automatically.

### The approval workflow

1. Driver submits a request with both mandatory photos.
2. Any Sir or Admin opens it, checks both photos, and signs digitally.
3. They click **Approve**.
4. Later, a Sir or Admin marks the request **Fuel Received** or **Not Received**.

There's no "assign this request to a specific Sir" step — any Sir or Admin can act on any request, so the first available person can handle it.

## The mandatory photo-review workflow

Every non-draft fuel request requires two photos, enforced on both the frontend and the backend:

1. **Fuel Machine Display Photo** — must show Liters, Price per Liter, and Total Amount on the pump's digital display.
2. **Money Receipt Photo** — the cash memo from the fuel station.

Any Sir or Admin must open **View Details** and explicitly click **"Mark as Reviewed"** on *each* photo separately — not just open the modal — before **Approve & Sign** becomes available. Editing an already-approved request's key details (amount, vehicle, either photo, etc.) automatically revokes the approval and both review flags, requiring re-review and re-signing.

## Photo Retention (3-month auto-delete)

To keep disk usage bounded, every request's photos — Fuel Machine Display Photo, Money Receipt Photo, and the approver's Signature — are automatically deleted **3 months after the request was created**. A background job inside the server checks once a day (shortly after startup, then every 24h) and removes any photo past that age.

Only the image files go — the record itself, its amounts, approval status, `approved_by`/`approved_at`, and full history timeline are permanent and untouched. The UI shows "automatically removed after 3 months" in place of the photo so this never looks like the photo was simply never provided.

## Backup & Restore

Settings → Backup & Restore exports the full database (requests, drivers, sirs, fuel types, stations, branding) as a small JSON file — images are stored as file paths, not embedded, so backups stay lightweight. Restoring replaces everything currently in the database, so use it carefully.

## Notes & Limitations

- Uploaded images are saved to `server/uploads/` on disk and served as static files — back up that folder along with your database if you move servers.
- The JWT token is the only thing stored in the browser's LocalStorage; every other feature (requests, drivers, sirs, settings, theme is the one exception — see below) lives in MySQL.
- Theme (light/dark/auto) is intentionally a personal, per-browser LocalStorage preference, not a shared server setting.
- This is designed to run on a single office's own machine/local network (the "local-deployment model"). If you deploy it to a shared cloud server, double-check the server's system timezone matches your office's — date validation ("date cannot be in the future") compares against the server's local clock.
- The Statistics/charts page was deliberately removed to keep the app simple — Dashboard still shows the key numbers each role needs (pending, approved, fuel received, monthly cost for admin), just without charts to read.
- Dashboard and the requests table refresh automatically (on navigating to them, plus a quiet background check every 60 seconds) so a tab left open for a while still catches up with what other people have submitted/approved — this isn't instant push, just a short-delay catch-up, which is enough for a small office's pace.

For production deployment (Hostinger VPS or any other Node.js host), required `.env` variables, MySQL setup, file permissions, backup procedure, and a full list of what was checked for production-readiness, see [PROJECT_HANDOVER.md](PROJECT_HANDOVER.md) §7–§11.

## Tech Used

- **Backend:** Node.js, Express, MySQL (via `mysql2`), JWT (`jsonwebtoken`), `bcryptjs`, Multer (file uploads), Helmet, CORS, `express-rate-limit`
- **Frontend:** HTML5, CSS3, vanilla JavaScript (ES6+, IIFE module pattern) — Font Awesome, jsPDF + jsPDF-AutoTable, SheetJS (all via CDN)
