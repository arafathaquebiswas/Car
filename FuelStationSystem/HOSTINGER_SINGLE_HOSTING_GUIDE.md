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

## 2. Clean Repository Architecture & Folder Structure

- **`main` Branch (PHP Production):** Clean production codebase containing `api/`, `client/`, `cron/`, `database/`, `.htaccess`, and deployment workflows.
- **`node-dev-archive/`:** Archived Node.js server files kept in `node-dev-archive/` (or separate `node-dev` branch) so the production root stays 100% clean.

---

## 3. Side-by-Side Folder Tree Diagram (Local Repository vs. Hostinger hPanel)

Below is the exact folder structure comparison between your **Local Repository** and **Hostinger hPanel File Manager (`public_html/fuel`)**:

```
+-------------------------------------------------------+-------------------------------------------------------+
|  LOCAL REPOSITORY WORKSPACE TREE (Git Source)         |  HOSTINGER hPANEL FILE MANAGER TREE (public_html/fuel)|
+-------------------------------------------------------+-------------------------------------------------------+
|  FuelStationSystem/                                   |  /home/uXXXXXXXX/public_html/fuel/ (or public_html/)  |
|  ├── .env.example                                     |  ├── .env                       [chmod 600, Secret]   |
|  ├── .htaccess                  [Apache Config]       |  ├── .htaccess                  [chmod 644]           |
|  ├── README.md                                        |  ├── api/                       [chmod 755]           |
|  ├── api/                       [PHP REST Engine]     |  │   ├── index.php              [Engine Router v1]    |
|  │   ├── config.php             [DB connection]       |  │   ├── config.php             [PDO DB Setup]        |
|  │   ├── index.php              [Router & Controller] |  │   └── jwt.php                [JWT Authentication]  |
|  │   └── jwt.php                [JWT encoder/decoder] |  ├── client/                    [chmod 755]           |
|  ├── client/                    [Static Frontend]     |  │   ├── index.html             [Main App SPA UI]     |
|  │   ├── index.html             [SPA UI HTML]         |  │   ├── script.js              [Frontend Logic]      |
|  │   ├── script.js              [Frontend Application]|  │   ├── style.css              [Styling & UI Theme]  |
|  │   ├── api.js                 [API Bridge]          |  │   ├── api.js                 [API Bridge Client]   |
|  │   ├── manifest.json          [PWA Manifest]        |  │   ├── manifest.json          [PWA Configuration]   |
|  │   ├── robots.txt             [No-index headers]    |  │   ├── logo/                  [Brand Assets]        |
|  │   ├── logo/                                        |  │   │   └── NGO_logo_monogram.webp                |
|  │   │   └── NGO_logo_monogram.webp                   |  │   └── assets/                                       |
|  │   └── assets/                                      |  │       └── icons/             [SVG Icons]           |
|  │       └── icons/             [9 SVG Icons]         |  │           ├── approved.svg                          |
|  │           ├── approved.svg                         |  │           ├── dashboard.svg                         |
|  │           ├── dashboard.svg                        |  │           ├── edit.svg                              |
|  │           ├── edit.svg                             |  │           ├── fuel-machine.svg                      |
|  │           ├── fuel-machine.svg                     |  │           ├── fuel-request.svg                      |
|  │           ├── fuel-request.svg                     |  │           ├── pending.svg                           |
|  │           ├── pending.svg                          |  │           ├── receipt.svg                           |
|  │           ├── receipt.svg                          |  │           ├── rejected.svg                          |
|  │           ├── rejected.svg                         |  │           └── signature.svg                         |
|  │           └── signature.svg                        |  ├── cron/                      [chmod 755]           |
|  ├── cron/                      [PHP Cron Jobs]       |  │   └── photo_retention.php    [90-Day Auto Delete]  |
|  │   └── photo_retention.php    [CLI Cron Handler]    |  ├── database/                  [chmod 755]           |
|  ├── database/                  [SQL Schemas]         |  │   └── fuel_station.sql       [DB Initial Schema]   |
|  │   └── fuel_station.sql       [MySQL Import Script] |  ├── logs/                      [chmod 775, Writable] |
|  ├── logo/                                            |  │   ├── app.log                [System Log]          |
|  │   └── NGO_logo_monogram.webp                       |  │   └── error.log              [Error Log]           |
|  ├── uploads/                   [Storage Folders]     |  └── uploads/                   [chmod 775, Writable] |
|  │   ├── .htaccess              [Security Script Off] |      ├── .htaccess              [Script Exec Off]     |
|  │   ├── driver-photos/         [.gitkeep]            |      ├── driver-photos/         [Driver Images]       |
|  │   ├── fuel-receipts/         [.gitkeep]            |      ├── fuel-receipts/         [Fuel Receipts]       |
|  │   ├── logo/                  [.gitkeep]            |      ├── logo/                  [Custom Logos]        |
|  │   ├── money-receipts/        [.gitkeep]            |      ├── money-receipts/        [Money Receipts]      |
|  │   ├── profile-photos/        [.gitkeep]            |      ├── profile-photos/        [Profile Pictures]    |
|  │   ├── signatures/            [.gitkeep]            |      ├── signatures/            [Digital Signatures]  |
|  │   └── vehicle-photos/        [.gitkeep]            |      └── vehicle-photos/        [Vehicle Pictures]    |
|  └── node-dev-archive/          [Archived Node Code]  |  *(Note: node-dev-archive/ is excluded on server)    |
+-------------------------------------------------------+-------------------------------------------------------+
```

### Naming Conventions & File Formatting Guidelines

1. **Folder Formatting**: Lowercase Unix standard (`api`, `client`, `cron`, `database`, `logs`, `uploads`).
2. **Upload Subfolder Formatting**: Lowercase kebab-case (`driver-photos`, `fuel-receipts`, `money-receipts`, `profile-photos`, `signatures`, `vehicle-photos`, `logo`).
3. **Database Tables & Columns**: Lowercase `snake_case` (`fuel_records`, `users`, `office_sirs`, `profile_photo`, `fuel_receipt_image`).
4. **PHP Files**: Lowercase `snake_case` or single words (`index.php`, `config.php`, `jwt.php`, `photo_retention.php`).
5. **Image Extensions**: Lowercase extensions only (`.webp`, `.png`, `.jpg`, `.svg`).
6. **File Permissions (`chmod`)**:
   - Directory Folders: `755` (`drwxr-xr-x`)
   - Normal Files: `644` (`-rw-r--r--`)
   - Storage Folders (`uploads/`, `logs/`): `755` or `775`
   - Secret File (`.env`): `600` (`-rw-------`)

---

## 3. Step-by-Step Hostinger hPanel Setup

1. **Subdomain:** Create subdomain `fuel` in hPanel pointing to `public_html/fuel`.
2. **SSL:** Activate Free SSL for `fuel.atmabiswas.org` in hPanel -> Security -> SSL.
3. **Database:** Create MySQL database & user, then import [`database/fuel_station.sql`](file:///Users/arafat/Desktop/Car/FuelStationSystem/database/fuel_station.sql) in phpMyAdmin.
4. **Environment File:** Create `.env` in `public_html/fuel/.env` with database credentials.
5. **Daily Cron Job:** In hPanel -> Cron Jobs, add a daily job (`0 0 * * *`):
   ```bash
   php /home/uXXXXXXXX/public_html/fuel/cron/photo_retention.php
   ```
6. **GitHub Actions Secrets:** Add `HOSTINGER_FTP_HOST`, `HOSTINGER_FTP_USER`, `HOSTINGER_FTP_PASSWORD` in GitHub Secrets. Pushing to `main` deploys and verifies health automatically!

---

## 4. Verified Hostinger Hosting Compatibility & Asset Hygiene

All files, paths, and assets have been systematically audited and verified for Hostinger Linux production environment:

1. **Strict Case-Sensitivity Compliance**: All `require()` statements in JS and `include`/`require_once` statements in PHP match disk file casing **100% strictly** (0 case mismatch errors).
2. **Relative Logo & Icon Paths**: Primary logo references (`logo/NGO_logo_monogram.webp`), favicons, PWA icons (`manifest.json`), and SVG icons in `client/assets/icons/` use relative paths to guarantee clean loading regardless of domain root vs. subfolder hosting.
3. **Upload Directory Tracking**: Standardized upload subdirectories (`uploads/profile-photos/`, `uploads/money-receipts/`, `uploads/signatures/`, `uploads/vehicle-photos/`, `uploads/driver-photos/`, `uploads/logo/`, `uploads/fuel-receipts/`) are tracked with `.gitkeep` placeholders and secured with `uploads/.htaccess`.
4. **Clean File Naming**: All image and icon extensions are strictly lowercase (`.webp`, `.png`, `.svg`) with zero spaces or illegal characters.

