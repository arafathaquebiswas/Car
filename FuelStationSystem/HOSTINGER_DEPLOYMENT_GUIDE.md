# Comprehensive Production Deployment Guide: Hostinger Shared Hosting

**Subdomain:** `https://fuel.atmabiswas.org/`  
**Main Domain:** `https://atmabiswas.org/`  
**Hosting Environment:** Hostinger Shared Hosting (Business / Cloud Hosting via hPanel)  
**Stack:** Node.js 18+ (Phusion Passenger / LiteSpeed), Express, MySQL / MariaDB, Apache / LiteSpeed  

---

## 1. Overview & Architecture

This guide provides the complete, production-grade deployment strategy for the **Fuel Station Management System** on Hostinger Shared Hosting.

On Hostinger Shared Hosting:
- Node.js is executed via **Phusion Passenger** or **LiteSpeed Node App Selector**.
- Apache / LiteSpeed handles static files, HTTPS termination, caching, and security header enforcement.
- MySQL / MariaDB serves as the database engine.
- Scheduled background tasks (such as the 3-month photo auto-delete policy) are decoupled into a standalone CLI script (`server/cron/photoRetentionCron.js`) executed via **Hostinger hPanel Cron Jobs** so they run reliably even when the Passenger Node process goes to sleep during idle periods.

---

## 2. Production Folder Structure

On Hostinger Shared Hosting, domain documents live under `/home/uXXXXXXXX/domains/atmabiswas.org/public_html/fuel` (or `/home/uXXXXXXXX/fuel.atmabiswas.org`).

```
fuel.atmabiswas.org/ (Root Directory)
├── .env                       # PRODUCTION environment variables (Gitignored, never overwritten)
├── .htaccess                  # Apache/LiteSpeed routing, HTTPS, Security headers, Cache rules
├── passenger.js               # Hostinger Phusion Passenger Node.js entry point
├── package.json               # Dependencies & production scripts
├── package-lock.json
├── HOSTINGER_DEPLOYMENT_GUIDE.md
├── client/                    # Static Frontend (served directly or via Express)
│   ├── index.html
│   ├── style.css
│   ├── api.js
│   ├── script.js
│   ├── manifest.json
│   ├── robots.txt             # Disallows search engine crawlers (User-agent: * Disallow: /)
│   └── assets/
├── server/                    # Node.js Express Backend
│   ├── app.js
│   ├── server.js
│   ├── config/
│   │   ├── db.js              # MySQL connection pool (tuned DB_CONNECTION_LIMIT=5)
│   │   ├── dbInit.js
│   │   └── seed.js
│   ├── controllers/
│   ├── middleware/
│   │   ├── upload.js          # Multer file upload validation & MIME mapping
│   │   └── errorHandler.js    # Production error handler (stack traces hidden)
│   ├── models/
│   ├── routes/
│   ├── scripts/
│   │   └── migrate.js         # Non-destructive DB migration script
│   ├── cron/
│   │   └── photoRetentionCron.js  # Daily CLI photo cleanup script for Hostinger Cron
│   ├── utils/
│   │   ├── logger.js          # File logger writing to /logs
│   │   └── photoRetentionJob.js
│   └── uploads/               # PERSISTENT UPLOADED IMAGES (Gitignored, never overwritten)
│       ├── .htaccess          # Security protection: script execution DISABLED (SetHandler none)
│       ├── fuel-receipts/
│       ├── money-receipts/
│       ├── driver-photos/
│       ├── vehicle-photos/
│       ├── signatures/
│       └── profile-photos/
├── database/
│   └── fuel_station.sql       # Initial SQL schema
├── logs/                      # Production logs (Gitignored)
│   ├── app.log
│   └── error.log
└── .github/
    └── workflows/
        └── deploy.yml         # GitHub Actions zero-downtime automated deployment workflow
```

---

## 3. Required DNS & Hostinger hPanel Settings

### A. DNS Configuration
In your DNS provider (Hostinger DNS Zone / Cloudflare / Namecheap):
1. **Type:** `A` Record
   - **Name / Host:** `fuel`
   - **Points to / IP Address:** `YOUR_HOSTINGER_SERVER_IP` (Found in Hostinger hPanel -> Server Information)
   - **TTL:** Auto / 300
2. *(Alternative if using CNAME)*:
   - **Name:** `fuel`
   - **Target:** `atmabiswas.org`

### B. Subdomain Creation in Hostinger hPanel
1. Log in to **Hostinger hPanel**.
2. Go to **Domains** -> **Subdomains**.
3. Enter Subdomain name: `fuel` (Result: `fuel.atmabiswas.org`).
4. Custom folder path: `public_html/fuel` (or default `domains/atmabiswas.org/public_html/fuel`).
5. Click **Create**.

### C. Free SSL Activation
1. Go to **Security** -> **SSL** in hPanel.
2. Select `fuel.atmabiswas.org` and click **Install SSL** (ZeroSSL / Let's Encrypt free certificate).
3. Enable **Force HTTPS**.

### D. Hostinger Node.js Application Setup
1. Go to **Advanced** -> **Node.js Manager** (or **Setup Node.js App**) in hPanel.
2. Click **Create Application**.
3. Configure the following values:
   - **Node.js Version:** `18.x` or `20.x`
   - **Application Mode:** `Production`
   - **Application Root:** `public_html/fuel`
   - **Application URL:** `fuel.atmabiswas.org`
   - **Application Startup File:** `passenger.js`
4. Click **Create** & then **Run npm install** (or run via SSH / GitHub Actions).

### E. Hostinger Cron Job Setup (Daily Photo Cleanup)
1. Go to **Advanced** -> **Cron Jobs** in hPanel.
2. Choose **Custom Cron Job**.
3. Set Schedule: **Once per day** (`0 0 * * *` - Midnight).
4. Command:
   ```bash
   node /home/uXXXXXXXX/domains/atmabiswas.org/public_html/fuel/server/cron/photoRetentionCron.js > /dev/null 2>&1
   ```
   *(Replace `uXXXXXXXX` with your Hostinger username)*.

---

## 4. Environment Variables Setup (`.env`)

Create `.env` directly in `/home/uXXXXXXXX/domains/atmabiswas.org/public_html/fuel/.env` on Hostinger:

```ini
# Server Environment
PORT=4000
NODE_ENV=production

# Hostinger MySQL Database Credentials
DB_HOST=localhost
DB_PORT=3306
DB_USER=uXXXXXXXX_fuel_user
DB_PASSWORD=YourStrongDatabasePassword123!
DB_NAME=uXXXXXXXX_fuel_db
DB_CONNECTION_LIMIT=5

# Auth & Security JWT (Generate a 64-char random hex: openssl rand -hex 32)
JWT_SECRET=e7b4f8a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8
JWT_EXPIRES_IN=8h

# Seed Admin Credentials (Used ONLY on first boot if no users exist)
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=SetSecureAdminPasswordHere!
SEED_ADMIN_NAME=System Administrator

# Upload Limits
MAX_UPLOAD_MB=12

# Allowed Origins
CORS_ORIGIN=https://fuel.atmabiswas.org
```

> [!CAUTION]
> Never commit `.env` to Git. Keep `.env` gitignored at all times.

---

## 5. Database Setup & Migration Strategy

### A. Initial Database Setup
1. In **Hostinger hPanel**, navigate to **Databases** -> **MySQL Databases**.
2. Create a new database: e.g., `uXXXXXXXX_fuel_db`.
3. Create a new MySQL user: e.g., `uXXXXXXXX_fuel_user` and assign a strong password.
4. Grant all privileges on `uXXXXXXXX_fuel_db` to `uXXXXXXXX_fuel_user`.
5. Click **phpMyAdmin** -> Select `uXXXXXXXX_fuel_db` -> Click **Import** -> Upload `database/fuel_station.sql` -> Click **Go**.

### B. Automated Zero-Downtime Migration Strategy
For all future deployments:
- Do NOT re-import `fuel_station.sql` as that would overwrite existing tables and user records.
- Run the migration script via SSH or automated deployment workflow:
  ```bash
  npm run migrate
  ```
- The migration script (`server/scripts/migrate.js`) executes non-destructive `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD INDEX` commands, keeping all user records, driver logins, and approval histories 100% intact.

---

## 6. GitHub Continuous Deployment Strategy

The recommended deployment method for Hostinger Shared Hosting is **GitHub Actions via SSH and Rsync**.

### Benefits:
- **Fast & Reliable**: Only modified files are transferred.
- **Zero Risk to Uploads**: `server/uploads/` is strictly excluded from deletion or overwriting.
- **Preserves Environment**: `.env` is strictly excluded.
- **Automated Process**: Pushing code to `main` branch deploys the application automatically within 30 seconds.

### GitHub Repository Secrets Setup:
In your GitHub repository, go to **Settings** -> **Secrets and variables** -> **Actions** -> Add the following secrets:

1. `HOSTINGER_SSH_HOST`: Your Hostinger server IP or hostname (e.g. `145.223.x.x` or `atmabiswas.org`)
2. `HOSTINGER_SSH_USER`: Your Hostinger SSH username (e.g. `uXXXXXXXX`)
3. `HOSTINGER_SSH_KEY`: Your SSH Private Key (`id_rsa` contents) generated in Hostinger hPanel -> **Advanced** -> **SSH Access**.
4. `HOSTINGER_SSH_PORT`: `65002` (Hostinger's default SSH port)
5. `HOSTINGER_TARGET_DIR`: `/home/uXXXXXXXX/domains/atmabiswas.org/public_html/fuel/`

### How the Workflow Operates (`.github/workflows/deploy.yml`):
1. Code pushed to `main`.
2. GitHub Actions runner checks out code & verifies dependencies.
3. Rsync syncs code to Hostinger target directory, **excluding**:
   - `.env`
   - `server/uploads/`
   - `.git/`
   - `node_modules/`
   - `logs/`
4. Post-deployment command runs `npm ci --only=production`, runs `node server/scripts/migrate.js`, and touches `passenger.js` / `server/tmp/restart.txt` to trigger an instant Phusion Passenger app reload with zero downtime.

---

## 7. Pre-Deployment Backup Strategy

Before initiating any major update or deployment:

### Database Backup:
1. **Via Hostinger hPanel:** Go to **Databases** -> **Backups** -> Generate MySQL Database Backup and download `.sql.gz`.
2. **Via phpMyAdmin:** Select database -> **Export** -> Quick -> **Go**.
3. **Via App Interface:** Log in as Admin -> Go to **Settings** -> **Backup & Restore** -> Download JSON backup.

### Uploads Folder Backup:
Via SSH or Hostinger File Manager:
```bash
cd /home/uXXXXXXXX/domains/atmabiswas.org/public_html/fuel
tar -czvf uploads_backup_$(date +%F).tar.gz server/uploads/
```

---

## 8. Rollback Strategy

If a newly deployed code version introduces a critical bug:

### A. Immediate Code Rollback (via GitHub Actions)
To roll back code to the previous stable commit:
```bash
git revert HEAD
git push origin main
```
GitHub Actions will automatically redeploy the previous working code to Hostinger within seconds.

### B. Manual SSH Rollback
If GitHub Actions is unavailable:
```bash
ssh -p 65002 uXXXXXXXX@YOUR_HOSTINGER_IP
cd /home/uXXXXXXXX/domains/atmabiswas.org/public_html/fuel
git checkout HEAD~1
touch server/tmp/restart.txt
```

### C. Database Rollback
If a database schema change needs to be reverted:
1. Log in to phpMyAdmin.
2. Import the pre-deployment `.sql` backup file.

---

## 9. Verification & Post-Deployment Checklist

After deploying to `https://fuel.atmabiswas.org/`, verify:

1. [ ] **HTTPS Enforcement**: Navigating to `http://fuel.atmabiswas.org` redirects automatically to `https://fuel.atmabiswas.org`.
2. [ ] **Health Endpoint**: `https://fuel.atmabiswas.org/api/health` returns `{"success":true,"message":"OK"}`.
3. [ ] **Robots.txt & Security Headers**: Check headers via browser DevTools or `curl -I https://fuel.atmabiswas.org/`. Confirm `X-Robots-Tag: noindex, nofollow`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`.
4. [ ] **Sensitive Files Protected**: Confirm `https://fuel.atmabiswas.org/.env` returns `403 Forbidden` or `404 Not Found`.
5. [ ] **Uploads Security**: Confirm `https://fuel.atmabiswas.org/uploads/` does not list files (`403 Forbidden`).
6. [ ] **User Login & Uploads**: Log in as Admin/Sir/Driver, submit a fuel request with mandatory photos, approve and verify photo display.
7. [ ] **Logs**: Confirm `logs/app.log` and `logs/error.log` are recording events cleanly in `/home/uXXXXXXXX/domains/atmabiswas.org/public_html/fuel/logs/`.
