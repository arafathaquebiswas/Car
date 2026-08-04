# Production Deployment Guide — Enterprise Edition (API v1)

**Subdomain:** `https://fuel.atmabiswas.org/`  
**Main Domain:** `https://atmabiswas.org/`  
**Hostinger Plan:** Single / Standard Web Hosting (PHP 8.1+ & MySQL Supported)  
**API Engine:** Native PHP 8 REST API Engine v1 (`/api/v1/`)  

---

## 1. Enterprise Feature Overview

The system includes **10 Enterprise Systems Engineering Features**:

1. **Health Check API (`GET /api/v1/health`)** ⭐⭐⭐⭐⭐
   - Evaluates Database connection and Storage writability in real time.
   - Response format:
     ```json
     {
       "status": "OK",
       "database": "Connected",
       "storage": "Writable",
       "version": "1.0.0",
       "environment": "production",
       "server_time": "2026-08-04T06:45:00"
     }
     ```
   - Automated post-deployment validation executed via GitHub Actions.

2. **Automated Pre-Deployment Backup & Health Guard** ⭐⭐⭐⭐⭐
   - `.github/workflows/deploy-sftp.yml` syncs changes, preserves `.env` & `/uploads`, and executes `/api/v1/health` post-deploy check.

3. **Storage Monitor (`GET /api/v1/system/storage`)** ⭐⭐⭐⭐⭐
   - Real-time disk and folder stats: Profile Photos, Fuel Photos, Receipt Photos, Signatures, Logs, Database Size, Remaining Disk Space.
   - Generates alert flag (`alert: true`) when usage exceeds 80%.

4. **Deployment Dashboard (`GET /api/v1/system/deployments`)** ⭐⭐⭐⭐⭐
   - Tracks Deployment History, Git Commit, Deployment Timestamp, Status, and Rollback Readiness.

5. **System Information (`GET /api/v1/system/info`)** ⭐⭐⭐⭐⭐
   - Displays PHP Version, MySQL Version, Server Time, Upload Limits, Memory Limits, Execution Time, DB Size, Total Users, Fuel Requests, and Images.

6. **API Versioning (`/api/v1/`)** ⭐⭐⭐⭐⭐
   - All endpoints prefixed with `/api/v1/`. Legacy `/api/` calls are automatically aliased to `/api/v1/` for 100% backward compatibility.

7. **Maintenance Mode (`POST /api/v1/system/maintenance`)** ⭐⭐⭐⭐⭐
   - Admin toggle for system maintenance. Non-admin users see `"System Under Maintenance. Please try again later."` (`HTTP 503 Service Unavailable`).

8. **Deployment Lock & Safety Guard** ⭐⭐⭐⭐⭐
   - Deployment pipeline verifies health response before marking release as successful.

9. **Environment Checker (`GET /api/v1/system/env-check`)** ⭐⭐⭐⭐⭐
   - Checks PHP Extensions (`pdo`, `pdo_mysql`, `gd`, `fileinfo`, `json`, `openssl`), Storage Writability, SSL status, Cron configuration.

10. **Release Notes (`GET /api/v1/system/release-notes`)** ⭐⭐⭐⭐⭐
    - Displays Version, Release Date, Developer Info, New Features, Bug Fixes, and Database Migration status.

---

## 2. Clean Repository Architecture

- **`main` Branch (PHP Production):** Clean production codebase containing `api/`, `client/`, `cron/`, `database/`, `.htaccess`, and deployment workflows.
- **`node-dev-archive/`:** Archived Node.js server files kept in `node-dev-archive/` (or separate `node-dev` branch) so the production root stays 100% clean.

---

## 3. Step-by-Step Hostinger hPanel Setup

1. **Subdomain:** Create subdomain `fuel` in hPanel pointing to `public_html/fuel`.
2. **SSL:** Activate Free SSL for `fuel.atmabiswas.org` in hPanel -> Security -> SSL.
3. **Database:** Create MySQL database & user, then import [`database/fuel_station.sql`](file:///Users/arafat/Desktop/FuelStationSystem/FuelStationSystem/database/fuel_station.sql) in phpMyAdmin.
4. **Environment File:** Create `.env` in `public_html/fuel/.env` with database credentials.
5. **Daily Cron Job:** In hPanel -> Cron Jobs, add a daily job (`0 0 * * *`):
   ```bash
   php /home/uXXXXXXXX/public_html/fuel/cron/photo_retention.php
   ```
6. **GitHub Actions Secrets:** Add `HOSTINGER_FTP_HOST`, `HOSTINGER_FTP_USER`, `HOSTINGER_FTP_PASSWORD` in GitHub Secrets. Pushing to `main` deploys and verifies health automatically!
