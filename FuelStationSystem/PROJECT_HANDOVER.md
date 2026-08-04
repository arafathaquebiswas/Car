# Fuel Station Management System — Project Handover

Full-stack office fuel-request & approval system: **Node.js + Express + MySQL** backend, vanilla HTML/CSS/JS frontend. This document is the final handover reference — project structure, schema, API surface, roles, and everything needed to install, deploy, and maintain the system in production.

The UI follows a "keep it simple" design: only three roles (Admin, Sir, Driver), a request form with the minimum fields an office actually needs, no assignment step (any Sir or Admin can review/approve any request), and no Statistics/charts page — so a driver with little technical experience can use it without training.

For day-to-day setup, see [README.md](README.md). This document goes deeper on architecture, deployment, and what's left for the future.

---

## 1. Project Folder Structure

```
FuelStationSystem/
├── client/                       Frontend — served as static files by Express
│   ├── index.html                 All pages/modals (single-page shell)
│   ├── style.css                  All styling (light/dark theme via CSS custom properties)
│   ├── api.js                     fetch() wrapper — the only place that talks HTTP
│   └── script.js                  All UI logic, rendering, and workflow (IIFE module)
├── server/                       Backend — Node.js + Express
│   ├── config/
│   │   ├── db.js                    mysql2 connection pool
│   │   └── seed.js                  First-run admin account seeding
│   ├── controllers/                 Request handlers (one per resource)
│   ├── middleware/
│   │   ├── auth.js                  requireAuth / requireRole(...)
│   │   ├── upload.js                 Multer config — MIME whitelist, size limit, safe filenames
│   │   └── errorHandler.js           Central error → JSON response mapping
│   ├── models/                      SQL queries (parameterized, mysql2)
│   ├── routes/                      Express route definitions
│   ├── uploads/                     Uploaded images (gitignored; folders kept via .gitkeep)
│   │   ├── fuel-receipts/             Fuel Machine Display Photos
│   │   ├── money-receipts/            Money Receipt Photos
│   │   ├── driver-photos/, vehicle-photos/, signatures/, logo/, profile-photos/
│   ├── utils/                       Small shared helpers (ApiError, asyncHandler, jwt, recordCode, fileCleanup)
│   └── server.js                    Entry point
├── database/
│   └── fuel_station.sql           Full schema + FKs + indexes + starter reference data
├── package.json
├── .env.example                   Copy to .env and fill in your own values
├── README.md                      Quick-start setup guide
└── PROJECT_HANDOVER.md            This document
```

**Architecture notes:**
- The frontend is a single HTML shell (`index.html`) with all "pages" as `<section>` elements toggled via JS — no client-side router, no build step, no bundler. Open `client/` in a browser and it's the whole app; in production it's served by Express as static files from the same origin as the API (no separate frontend deployment needed).
- `script.js` is one IIFE — all state is module-private `let` variables, no global leakage beyond `window.api`.
- Every uploaded file gets a server-generated, content-addressed filename (`<timestamp>-<random-hex>.<ext-from-validated-mime-type>`) — never derived from the client's original filename, which also closes off path-traversal and extension-spoofing risks.

---

## 2. Database Schema Summary

MySQL 8+, InnoDB, `utf8mb4`. 8 tables:

| Table | Purpose | Key constraints |
|---|---|---|
| **users** | Login accounts (Admin/Sir/Driver) | `UNIQUE(username)`, `UNIQUE(employee_id)`, `UNIQUE(driver_id)`, `UNIQUE(sir_id)` — the last two prevent two logins ever sharing one driver/sir profile. FKs to `drivers`/`office_sirs` (`ON DELETE SET NULL`). |
| **drivers** | Reference list of drivers + profile fields | `UNIQUE(name)`. `vehicle_numbers` is a `JSON` array. FK to `fuel_types` for the default fuel type (`ON DELETE SET NULL`). |
| **office_sirs** | Reference list of sirs/approvers + department/designation | `UNIQUE(name)`. Kept in the schema for backward compatibility and the `/api/sirs` endpoint, but the Add Request form no longer collects a sir — `fuel_records.sir_id` is effectively unused going forward (see below). |
| **fuel_types** | Configurable fuel type list | `UNIQUE(name)`. |
| **stations** | Configurable fuel station list | `UNIQUE(name)`. |
| **fuel_records** | Core record — one row per fuel request | `UNIQUE(record_code)`. FKs to `drivers`/`office_sirs`/`fuel_types` (default `RESTRICT` — can't delete a driver/sir/fuel type still referenced by a record) and to `users.created_by` (`SET NULL`). 9 indexes (date, driver, sir, fuel type, approval status, draft flag, receipt no., vehicle no., station). |
| **approval_history** | Full audit trail per record | FK to `fuel_records` (`ON DELETE CASCADE` — history is auto-cleaned when a record is deleted). |
| **settings** | Single-row office config (name/logo/currency/theme) | `CHECK (id = 1)` enforces exactly one row. |

**Notable design decisions:**
- `fuel_records.sir_id` and `fuel_type_id` are nullable — a **draft** can be saved before a fuel type is chosen (fuel type becomes required once the draft is completed); `sir_id` is now *always* optional (the "assign to a specific sir" step was removed — any Sir or Admin can approve any request, so there's nothing to assign). Old records created before this change may still carry a `sir_id`, which the UI still displays harmlessly where present, but nothing new sets it.
- `machine_photo_reviewed` / `money_receipt_reviewed` are two independent flags (not one combined flag) — both must be true before the "Approve & Sign" gate opens.
- Every write to `fuel_records` outside direct SQL goes through parameterized `?` placeholders — no user input is ever concatenated into a query string. The only dynamic SQL fragments (`settingsModel.js`, `userModel.js`, `backupModel.js`) build column/table *names* from hardcoded developer-controlled maps, never from request bodies.
- `reportModel.js` no longer joins `office_sirs` at all (the "By Office Sir" report type was removed along with it), and joins `fuel_types` with `LEFT JOIN`, never `INNER JOIN` — with `sir_id` now null on virtually every new record, an inner join on either table would have silently excluded every new request from every report.

---

## 3. API Endpoint List

All endpoints are prefixed `/api`. 🔒 = requires a valid JWT (`Authorization: Bearer <token>`). 👑 = admin only. 👑🖋️ = admin or sir.

### Auth
| Method | Path | Access |
|---|---|---|
| POST | `/auth/login` | public |
| POST | `/auth/logout` | public (stateless no-op) |
| GET | `/auth/me` | 🔒 |
| POST | `/auth/register` | 👑 (legacy — superseded by `/users`, kept for backward compatibility) |

### Users (Admin User Management + self-service Profile)
| Method | Path | Access |
|---|---|---|
| GET | `/users/me` | 🔒 own profile |
| PUT | `/users/me` | 🔒 own profile (name/phone/email/photo only) |
| POST | `/users/me/change-password` | 🔒 own account |
| GET | `/users` | 👑 — supports `?search=&role=&status=` |
| GET | `/users/:id` | 👑 |
| POST | `/users` | 👑 — create Admin/Sir/Driver |
| PUT | `/users/:id` | 👑 — edit (username/role are permanent) |
| POST | `/users/:id/reset-password` | 👑 |
| POST | `/users/:id/activate` | 👑 |
| POST | `/users/:id/deactivate` | 👑 |
| DELETE | `/users/:id` | 👑 — deletes the login only, keeps the linked driver/sir profile |

### Drivers / Sirs / Fuel Types / Stations (identical shape ×4)
| Method | Path | Access |
|---|---|---|
| GET | `/drivers`, `/sirs`, `/fuel-types`, `/stations` | 🔒 any role |
| POST | same | 👑 |
| DELETE | `/…/:id` | 👑 (409 if still referenced by a fuel record) |

### Fuel Records (Fuel Requests)
| Method | Path | Access |
|---|---|---|
| GET | `/records` | 🔒 — **role-scoped**: driver sees only their own; sir and admin both see **all** requests (no assignment step) |
| GET | `/records/:code` | 🔒 — same scoping enforced per-resource |
| POST | `/records` | 🔒 any role (multipart: `fuelReceiptImage`, `moneyReceiptImage`; `driverPhotoImage`/`vehiclePhotoImage` fields still accepted server-side for backward compatibility but no longer sent by the simplified client form) |
| PUT | `/records/:code` | 🔒 same scoping; 423 if locked (approved) |
| DELETE | `/records/:code` | 👑 |
| POST | `/records/:code/review` | 👑🖋️ — body `{ image: "machine" \| "money" }` — any sir or admin, not just an "assigned" one |
| POST | `/records/:code/approve` | 👑🖋️ — multipart, includes `signatureImage` — any sir or admin |
| POST | `/records/:code/unlock` | 👑 |
| POST | `/records/:code/fuel-status` | 👑🖋️ — body `{ status: "received" \| "not_received" }` — any sir or admin |

### Reports / Settings / Backup
| Method | Path | Access |
|---|---|---|
| GET | `/reports?type=monthly\|range\|driver\|vehicle\|station&...` | 🔒 — the `sir` report type was removed along with the "By Office Sir" filter |
| GET | `/settings` | 🔒 |
| PUT | `/settings` | 👑 — multipart (`logo`) |
| GET | `/backup/export` | 👑 |
| POST | `/backup/import` | 👑 |
| DELETE | `/backup/clear-all` | 👑 |

### Misc
| Method | Path | Access |
|---|---|---|
| GET | `/api/health` | public — liveness check |
| GET | `/uploads/**` | public static files (cached 7 days, immutable) |

---

## 4. User Roles & Permissions

Redesigned around a "keep it simple" principle: only three roles, and no per-request assignment step — any Sir or Admin can act on any request, not just ones addressed to them.

| Capability | Admin | Sir | Driver |
|---|:---:|:---:|:---:|
| Dashboard | ✅ (Total, Pending, Approved, Fuel Received, Monthly Cost) | ✅ (Pending, Approved Today, Fuel Received — all requests) | ✅ (My Pending, My Approved, My Fuel Received — own only) |
| Add Fuel Request | ✅ | ❌ | ✅ (own name only, locked) |
| View requests | All | All | Own only |
| Edit requests | Any, unless locked | Any, unless locked | Own only, unless locked |
| Delete requests | ✅ | ❌ | ❌ |
| Review mandatory photos | ✅ (any request) | ✅ (any request) | ❌ (read-only status) |
| Approve & Sign | ✅ (any request) | ✅ (any request) | ❌ (read-only status) |
| Set Fuel Received/Not Received | ✅ (any request) | ✅ (any request) | ❌ (read-only status) |
| Unlock a locked request | ✅ | ❌ | ❌ |
| Reports | ✅ | ✅ | ❌ |
| User Management (create/edit/reset/disable/delete) | ✅ | ❌ | ❌ |
| Settings (drivers/fuel types/stations/branding) | ✅ | ❌ | ❌ |
| Backup / Restore / Clear Data | ✅ | ❌ | ❌ |
| Own Profile (view/edit/change password) | ✅ | ✅ | ✅ |

Nav per role:
- **Admin**: Dashboard, Add Fuel Request, All Requests, Reports, User Management, Settings, Profile.
- **Sir**: Dashboard, All Requests, Reports, Profile.
- **Driver**: Dashboard, Add Fuel Request, My Fuel Requests, Profile.

The Statistics/charts page was removed entirely — it doesn't appear in any role's nav.

Enforcement is **two-layered**: the sidebar hides entire nav sections a role can't use (not just individual buttons), and the API independently enforces the same rules via `requireRole(...)` and per-resource ownership checks (`recordController.assertRecordAccess`, which now only checks that a driver is accessing their own request — there is no more sir-ownership check) — a direct API call bypassing the UI gets the same 403s.

**Known pre-existing gap (not introduced by this redesign, not yet closed):** `POST /api/records` isn't role-restricted at the route level, so a Sir could theoretically reach the Add Request form via a direct URL hash despite it being hidden from their nav. Low risk (a Sir submitting their own fuel request isn't a meaningful security issue), flagged here for awareness rather than fixed, since it predates and is unrelated to this redesign.

---

## 5. Default Login Credentials

Seeded automatically on first server start (from `.env`, only if the `users` table is empty):

```
Username: admin
Password: admin123
```

**Change `SEED_ADMIN_PASSWORD` in `.env` before first run in any real deployment**, or change it immediately after first login via Settings → Profile → Change Password.

---

## 6. Installation Guide (Local Development)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# edit .env — at minimum set a real JWT_SECRET (openssl rand -hex 32)
# and your MySQL credentials

# 3. Create the database
mysql -u root -p < database/fuel_station.sql

# 4. Start the server
npm start          # or: npm run dev   (nodemon, auto-restart on backend changes)

# 5. Open http://localhost:4000 and log in with the admin account above
```

Requirements: Node.js ≥ 18, MySQL 8+ (or MariaDB).

---

## 7. Production Deployment Guide — Hostinger VPS (recommended)

This app is designed for a **single office's own server or a small VPS** — one Express process serving both the API and the static frontend, with MySQL alongside it. Node's `net.Server` graceful shutdown (SIGTERM/SIGINT — see `server/server.js`) and the MySQL pool's error recovery (see `server/config/db.js`) are both built to work cleanly with a process manager, so systemd or PM2 restarting the app during a deploy is safe.

**Do not deploy this to Netlify or any static-hosting/serverless-only platform.** Netlify (and similar) only serve static files — this app needs a long-running Node process (for the MySQL connection pool, the daily photo-retention job, and file uploads written to local disk), none of which a static host or a stateless serverless function can provide. A Hostinger **VPS** (or any plain Node.js-capable VPS/server) is the right target; a "static site" or "Jamstack" hosting plan is not.

The steps below assume a **Hostinger VPS** running Ubuntu (KVM/Ubuntu 22.04, either from Hostinger's OS template gallery in hPanel or a clean Ubuntu install) — they're standard Ubuntu steps, so they carry over unchanged to any other Ubuntu-based Node.js VPS provider too.

### 7.1 Provision the VPS and prep the server

1. In **Hostinger hPanel → VPS**, create/select a VPS and pick an **Ubuntu 22.04 LTS** OS template (skip any pre-bundled app template — this project brings its own Node.js/MySQL setup). Note the VPS's public IP.
2. Point your domain's DNS `A` record at that IP (or use the VPS's IP directly for a LAN-only/internal deployment with no domain).
3. SSH in as root (Hostinger shows the root password / lets you upload an SSH key in hPanel) and install the stack:

```bash
# Ubuntu 22.04, as used by Hostinger's VPS templates
sudo apt update && sudo apt install -y nodejs npm mysql-server nginx
sudo mysql_secure_installation
```

If Ubuntu's default `nodejs` package is older than 18, install a current one from NodeSource instead:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # confirm >= 18
```

Create a dedicated, least-privilege MySQL user instead of using `root`:

```sql
CREATE USER 'fsms_app'@'localhost' IDENTIFIED BY 'a-long-random-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON fuel_station.* TO 'fsms_app'@'localhost';
FLUSH PRIVILEGES;
```

### 7.2 Deploy the app

```bash
git clone <your-repo> /var/www/fsms   # or scp/rsync the project folder
cd /var/www/fsms
npm ci --omit=dev
cp .env.example .env                  # fill in production values — see §8
mysql -u fsms_app -p fuel_station < database/fuel_station.sql
```

**File/folder permissions** — the app writes uploaded photos to `server/uploads/**` and needs to read/write that tree as whichever OS user runs the Node process (`www-data` in the systemd unit below). After cloning:

```bash
sudo chown -R www-data:www-data /var/www/fsms
sudo find /var/www/fsms/server/uploads -type d -exec chmod 755 {} \;
sudo find /var/www/fsms/server/uploads -type f -exec chmod 644 {} \;
```
755/644 is enough — the app never needs to execute anything inside `uploads/`, only read and write plain image files. Don't run the whole app as `root`; a compromised or buggy request handler then only has the `www-data` user's limited permissions, not root's.

If you're behind Hostinger's hPanel firewall (or plain `ufw`), only port 443 (and 80, for the Let's Encrypt redirect) needs to be open to the internet — Node's own port 4000 should stay closed to outside traffic and only reachable from Nginx on `127.0.0.1`, which the Nginx config in §7.4 already assumes.

### 7.3 Run it as a service (systemd)

`/etc/systemd/system/fsms.service`:

```ini
[Unit]
Description=Fuel Station Management System
After=network.target mysql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/fsms
ExecStart=/usr/bin/node server/server.js
Restart=on-failure
EnvironmentFile=/var/www/fsms/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fsms
sudo systemctl status fsms
```

(PM2 — `pm2 start server/server.js --name fsms` — is an equally good alternative if you prefer it over systemd.)

### 7.4 Reverse proxy with Nginx (TLS termination + serving on port 443)

`/etc/nginx/sites-available/fsms`:

```nginx
server {
    listen 80;
    server_name fuel.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name fuel.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/fuel.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fuel.yourdomain.com/privkey.pem;

    client_max_body_size 15M;   # a little above MAX_UPLOAD_MB so Nginx never rejects first

    location / {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/fsms /etc/nginx/sites-enabled/
sudo certbot --nginx -d fuel.yourdomain.com   # Let's Encrypt TLS cert
sudo nginx -t && sudo systemctl reload nginx
```

An equivalent Apache vhost uses `ProxyPass`/`ProxyPassReverse` to `http://127.0.0.1:4000/` with `mod_ssl` for TLS — same idea, different config syntax.

### 7.5 Production checklist

- [ ] `NODE_ENV=production` in `.env`
- [ ] `JWT_SECRET` is a real random value (`openssl rand -hex 32`), not the dev default
- [ ] `SEED_ADMIN_PASSWORD` changed before first boot, then the admin password changed again post-login
- [ ] `CORS_ORIGIN` left blank unless something *other than this app's own frontend* (a separate mobile app, another site) needs to call the API cross-origin — blank now correctly means same-origin-only (see `server/app.js`), it does not mean "allow any origin"
- [ ] MySQL app user has only `SELECT/INSERT/UPDATE/DELETE` on `fuel_station.*`, not full privileges
- [ ] TLS via Nginx/Apache in front of Node (the app itself doesn't terminate TLS) — if you deliberately run plain HTTP only (e.g. an internal-LAN-only deployment with no public exposure), that also works: the CSP no longer force-upgrades the app's own asset/API requests to HTTPS (see §11)
- [ ] `server/uploads/` and MySQL data directory both included in your backup routine (see §9), with permissions set per §7.2
- [ ] Server's system timezone matches the office's — date validation ("can't be in the future") compares against server-local time
- [ ] Confirmed the app survives `sudo systemctl restart fsms` without dropping in-flight requests (graceful SIGTERM handling — see `server/server.js`) and survives a brief MySQL restart without needing a Node restart itself (see `server/config/db.js`'s pool error handler)

---

## 8. Recommended Environment Variables

| Variable | Local dev | Production recommendation |
|---|---|---|
| `PORT` | `4000` | `4000` (kept internal, Nginx exposes 443) |
| `NODE_ENV` | `development` | `production` |
| `DB_HOST` / `DB_PORT` | `localhost` / `3306` | Same, unless MySQL is on a separate host |
| `DB_USER` / `DB_PASSWORD` | `root` / blank | Dedicated `fsms_app` user, strong password (see §7.1) |
| `DB_NAME` | `fuel_station` | Same |
| `JWT_SECRET` | any string | `openssl rand -hex 32` — real secret, never committed |
| `JWT_EXPIRES_IN` | `8h` | `8h`–`12h` for an office shift; shorter if higher security is needed |
| `SEED_ADMIN_USERNAME/PASSWORD/NAME` | `admin` / `admin123` | Set a real password before first boot |
| `MAX_UPLOAD_MB` | `12` | `12` is generous for phone-camera photos; raise only if needed |
| `CORS_ORIGIN` | blank (same-origin dev) | Your exact production origin(s), comma-separated |

---

## 9. Backup Strategy

Two things need backing up — they must be restored **together** (the DB has file *paths*, not the files themselves):

1. **Database**: Settings → Backup & Restore exports a JSON snapshot (records, drivers, sirs, fuel types, stations, branding) via the UI, or automate it with `mysqldump`:
   ```bash
   mysqldump -u fsms_app -p fuel_station > backup-$(date +%F).sql
   ```
2. **`server/uploads/`**: the actual image files. Sync this folder alongside the database dump:
   ```bash
   rsync -a /var/www/fsms/server/uploads/ /path/to/backup-destination/uploads/
   ```

**Recommended schedule**: a nightly cron job doing both, retaining ~30 days locally and shipping a copy off-site (another server, S3-compatible storage, etc.) weekly. Restoring via the in-app "Restore (Import JSON)" **replaces all current records/drivers/sirs/fuel types/stations** — always confirm you're restoring the intended file before confirming the destructive prompt.

**Photo retention job**: `server/utils/photoRetentionJob.js` runs once a day inside the Node process and permanently deletes any record's photos (both mandatory photos, the two optional ones, and the sir's signature) once the record is more than 3 months old — the record's data, approval status, and history are never touched, only the image files. This is intentional and by design (see README § Photo Retention), but it means **if you want an image archive older than 3 months, your backups must run more often than that retention window** — the images are genuinely gone from both disk and DB after they expire, `server/uploads/` backups taken later won't have them.

---

## 10. Future Improvements

Realistic next steps, roughly in priority order:

1. **Image content verification** — current upload validation checks the declared MIME type and file size; it doesn't inspect actual file bytes (magic numbers). Adding a library like `file-type` to verify the real image format would close the last gap in upload validation (the extension is already safely derived from the validated MIME type, so this is defense-in-depth, not an open vulnerability).
2. **Automated test suite** — this project has been repeatedly verified via live E2E scripts (Node `fetch` + headless-Chrome Puppeteer) during development and QA passes, but there's no persisted test suite in the repo. Porting those into a proper `tests/` folder (Jest/Vitest + Playwright) would let future changes be verified automatically instead of re-running ad hoc scripts.
3. **Token revocation / refresh tokens** — JWTs are stateless and expire on their own, but there's no way to force-logout a specific user before their token naturally expires (e.g., after deactivating them, their existing token still works until it expires). A short-lived access token + refresh token pair, or a server-side revocation list, would close this.
4. **Pagination** — `GET /api/records` and `GET /api/users` return the full result set. Fine for a small office (dozens to low hundreds of records/users); would need cursor- or offset-based pagination if usage grows into the thousands.
5. **users.role / users.is_active indexes** — not needed at current expected scale (a small office's user count), but worth adding if the user table ever grows large.
6. **Real-time push updates** — Dashboard/Records currently refresh via a background poll (every 60s while the tab is visible) plus an immediate refetch whenever you navigate to those pages (see §11.1). That's a deliberate, simple middle ground — genuinely instant updates would need WebSockets/SSE, which is more infrastructure than a small office app like this needs.
7. **Multi-office support** — the schema and settings table currently assume a single office. A `office_id` column across the reference tables would let one deployment serve multiple offices/branches.
8. **Audit log UI** — `approval_history` already captures a full trail per record; there's no equivalent for user-management actions (who created/edited/deactivated which account). Worth adding if compliance requirements need it.
9. **CI/CD** — a GitHub Actions workflow running lint + the test suite (once added) on every push, and automated deploy on merge to main.

---

## 11. Production Readiness Review — What Changed and What Remains

A full production QA pass (mobile responsiveness, all three roles' complete workflows, hosting readiness, and a general production-hardening review) was carried out after the "Keep It Simple" redesign. Findings and fixes:

### 11.1 Fixed during this review

- **CSP was silently breaking the app on any non-`localhost` HTTP deployment.** Helmet's default Content-Security-Policy includes `upgrade-insecure-requests`, which makes browsers rewrite every `http://` asset/API request to `https://`. Chrome exempts literal `localhost`, which is why this never surfaced during ordinary local testing — but on a real LAN IP, internal hostname, or a VPS address without TLS in front (the exact "local-deployment model" this app documents), every request for `style.css`, `script.js`, `api.js`, and the uploaded photos would fail with `ERR_SSL_PROTOCOL_ERROR`, leaving an unstyled, non-functional page. Reproduced live via Chrome pointed at a non-localhost hostname, then fixed by disabling that directive in `server/app.js` (Nginx/TLS in front still works exactly as documented in §7.4 if you add it — this only stops the CSP from *assuming* TLS exists when it might not).
- **`express-rate-limit` wasn't proxy-aware.** Without `app.set("trust proxy", 1)`, every request behind Nginx (§7.4) would appear to come from Nginx's own IP, meaning the whole office would share one 300-requests/15-minutes bucket instead of each person getting their own. Fixed in `server/app.js`.
- **A lost idle MySQL connection could crash the entire Node process.** mysql2's pool emits an `'error'` event for connections lost while idle (e.g., MySQL restarting for maintenance); with no listener, Node treats that as an uncaught exception and exits. Verified live by stopping and restarting MySQL under a running server: before the fix, this was a real risk of the whole office losing the app until someone noticed and restarted it manually; after the fix (`server/config/db.js`), the app logs the error, recovers automatically once MySQL is back, and never needs a Node restart.
- **No graceful shutdown.** `systemctl restart fsms` (or a PM2 restart) during a future deploy would previously cut the process immediately. `server/server.js` now handles `SIGTERM`/`SIGINT` by closing the HTTP server and the MySQL pool cleanly first. Verified live.
- **`CORS_ORIGIN` blank didn't mean what its own comment said.** The code set `origin: true` (reflect back and allow *any* origin) when unset, while the comment claimed "same-origin only." Since this app always serves its frontend and API from the same origin, there was no legitimate reason for the permissive default — fixed to `origin: false` in `server/app.js`, which now actually matches the documented intent with no effect on the normal deployment.
- **Dashboard/Records could go stale during a long session.** Data was only ever fetched once at login; a Sir or Admin who left a tab open for hours wouldn't see new driver submissions or other approvals without a manual page reload. `client/script.js` now quietly refetches records whenever you navigate to Dashboard/Records, plus a background poll every 60 seconds while the tab is visible (see item 6 above for why this — not full real-time push — was the right amount of complexity to add).
- **Missing favicon** caused a `404` on every single page load. Added an inline SVG favicon (no extra asset file needed).
- **Print button / photo-race and black-photo-on-capture bugs** from earlier in this project's history remain fixed and were re-verified as part of this pass (see README's photo-review workflow section).

### 11.2 Verified working, no changes needed

- All three roles' complete workflows (driver submission incl. camera + gallery + retake/replace, sir review/zoom/sign/approve/fuel-status, admin approving *any* driver's request, drivers/fuel-types/stations management, report generation, PDF/Excel export on both the Records and Reports pages, backup export + restore round-trip, branding/preference settings) — live end-to-end, against a real MySQL database.
- Role-boundary enforcement at the API level: a driver's token gets a real `403`/`401` against every admin/sir-only endpoint tested, independent of what the UI hides.
- JWT expiration/invalidation — both "expired token already in storage when the app loads" and "token goes bad mid-session" cleanly bounce to the login screen with a clear toast, never a blank or broken page.
- A hard page reload mid-session preserves the logged-in state and correct role-specific nav.
- Mobile layout at Android- and iPhone-sized viewports (Chrome's device emulation: no horizontal overflow anywhere, sidebar collapses to a slide-in drawer with a working hamburger toggle, forms/dashboard cards/tables all reflow per the breakpoints in `client/style.css`, upload boxes are large tap targets, tables scroll horizontally within their own container rather than the page).
- HEIC/HEIF photos (the default format on many iPhones) are handled correctly *by construction*, not luck: every upload path — gallery picker and the in-page camera — re-encodes to JPEG client-side via canvas (`readAndCompressImage()`/`captureCameraFrame()` in `client/script.js`) before anything reaches the server, so the server's JPG/PNG/WEBP/GIF allow-list never actually has to deal with HEIC bytes.

### 11.3 Known limitations (accurate as of this review)

- **Mobile verification was done via Chrome's device-emulation mode** (Android/iPhone viewport sizes + user agents, run headless) plus a source-level check of known iOS/Android-specific concerns (`playsinline`/`autoplay`/`muted` on the camera `<video>`, the viewport meta tag, touch-drag on the signature pad using non-passive listeners). This environment has no physical Android/iPhone device and no real Safari/WebKit engine available to test against, so genuine WebKit rendering quirks or real camera-permission-prompt UX on an actual iPhone haven't been physically verified — only their Chromium-engine approximation. Recommend a quick real-device smoke test (one Android phone, one iPhone) before full office rollout, focused on: camera permission prompt wording, actual photo quality/orientation from the rear camera, and the signature pad's touch feel.
- **The photo/image zoom viewer has no native pinch-to-zoom gesture** — it uses zoom in/out/reset buttons, click-to-toggle, and (on desktop) scroll-wheel zoom, which covers the core "inspect this photo closely" need on a touchscreen via taps, but isn't a multi-touch pinch gesture.
- Everything already listed in §10 (Future Improvements) still applies — none of those are new gaps introduced by this review, and none were treated as blocking for production office use.
