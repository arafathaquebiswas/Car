const pool = require("../config/db");
const ApiError = require("../utils/ApiError");
const recordModel = require("./recordModel");
const settingsModel = require("./settingsModel");
const { createSimpleListModel } = require("./simpleListModel");

const driverModel = createSimpleListModel("drivers");
const sirModel = createSimpleListModel("office_sirs");
const fuelTypeModel = createSimpleListModel("fuel_types");
const stationModel = createSimpleListModel("stations");

async function exportBackup() {
  const [records, drivers, sirs, fuelTypes, stations, settings] = await Promise.all([
    recordModel.getAll(),
    driverModel.getAll(),
    sirModel.getAll(),
    fuelTypeModel.getAll(),
    stationModel.getAll(),
    settingsModel.get(),
  ]);

  return {
    type: "fsms-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    records,
    drivers: drivers.map((d) => d.name),
    sirs: sirs.map((s) => s.name),
    fuelTypes: fuelTypes.map((f) => f.name),
    stations: stations.map((s) => s.name),
    officeName: settings.officeName,
    logo: settings.logo,
    currency: settings.currency,
    theme: settings.theme,
  };
}

// Fully replaces all reference lists and fuel records with the contents of
// a backup file. Runs inside a single transaction so a failure partway
// through leaves the original data untouched rather than half-overwritten.
async function importBackup(data) {
  if (!data || !Array.isArray(data.records) || !Array.isArray(data.drivers) || !Array.isArray(data.sirs)) {
    throw new ApiError(400, "Invalid backup file — missing required data.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query("DELETE FROM approval_history");
    await conn.query("DELETE FROM fuel_records");
    await conn.query("DELETE FROM drivers");
    await conn.query("DELETE FROM office_sirs");
    await conn.query("DELETE FROM fuel_types");
    await conn.query("DELETE FROM stations");

    const nameToId = { drivers: {}, sirs: {}, fuelTypes: {} };

    for (const name of data.drivers) {
      const [r] = await conn.query("INSERT INTO drivers (name) VALUES (?)", [name]);
      nameToId.drivers[name] = r.insertId;
    }
    for (const name of data.sirs) {
      const [r] = await conn.query("INSERT INTO office_sirs (name) VALUES (?)", [name]);
      nameToId.sirs[name] = r.insertId;
    }
    for (const name of (data.fuelTypes || [])) {
      const [r] = await conn.query("INSERT INTO fuel_types (name) VALUES (?)", [name]);
      nameToId.fuelTypes[name] = r.insertId;
    }
    for (const name of (data.stations || [])) {
      await conn.query("INSERT INTO stations (name) VALUES (?)", [name]);
    }

    // Ensure every name a record references actually exists, even if it was
    // missing from the driver/sir/fuel-type lists in the backup file.
    async function ensureId(map, table, name) {
      if (!name) return null;
      if (map[name]) return map[name];
      const [r] = await conn.query(`INSERT INTO ${table} (name) VALUES (?)`, [name]);
      map[name] = r.insertId;
      return r.insertId;
    }

    for (const rec of data.records) {
      const driverId = await ensureId(nameToId.drivers, "drivers", rec.driver);
      const sirId = await ensureId(nameToId.sirs, "office_sirs", rec.sirName);
      const fuelTypeId = await ensureId(nameToId.fuelTypes, "fuel_types", rec.fuelType);

      // Backward-compatible with backups exported before the two mandatory
      // photos got individually-tracked review flags: an old backup only
      // has the single `reviewedForApproval`, which meant "already fully
      // reviewed" — treat that as both photos reviewed.
      const machineReviewed = rec.machinePhotoReviewed != null ? rec.machinePhotoReviewed : rec.reviewedForApproval;
      const moneyReviewed = rec.moneyReceiptReviewed != null ? rec.moneyReceiptReviewed : rec.reviewedForApproval;

      const [result] = await conn.query(
        `INSERT INTO fuel_records
          (record_code, record_date, record_time, driver_id, sir_id, vehicle_number,
           station_name, odometer, fuel_type_id, liters, price_per_liter, total_amount,
           receipt_number, remarks, office_remarks, fuel_receipt_image, money_receipt_image,
           driver_photo_image, vehicle_photo_image, signature_image, is_draft,
           machine_photo_reviewed, money_receipt_reviewed, approval_status, approved_by, approved_at, is_locked, fuel_received)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rec.id, rec.date, rec.time || "00:00:00", driverId, sirId, rec.vehicleNumber,
          rec.stationName || null, rec.odometer || null, fuelTypeId,
          rec.liters || 0, rec.pricePerLiter || 0, rec.totalAmount || 0,
          rec.receiptNumber || null, rec.remarks || null, rec.officeRemarks || null,
          rec.fuelReceiptImage || null, rec.moneyReceiptImage || null,
          rec.driverPhotoImage || null, rec.vehiclePhotoImage || null, rec.signature || null,
          rec.isDraft ? 1 : 0, machineReviewed ? 1 : 0, moneyReviewed ? 1 : 0,
          rec.approvalStatus || "pending", rec.approvedBy || null,
          rec.signedAt ? new Date(rec.signedAt) : null, rec.locked ? 1 : 0, rec.fuelReceived || null,
        ]
      );

      for (const h of (rec.history || [])) {
        await conn.query(
          "INSERT INTO approval_history (record_id, action, performed_by, note, created_at) VALUES (?, ?, ?, ?, ?)",
          [result.insertId, h.action, h.by, h.note || "", h.at ? new Date(h.at) : new Date()]
        );
      }
    }

    if (data.officeName || data.currency || data.theme || data.logo !== undefined) {
      const settingsFields = {};
      if (data.officeName) settingsFields.officeName = data.officeName;
      if (data.currency) settingsFields.currency = data.currency;
      if (data.theme) settingsFields.theme = data.theme;
      if (data.logo !== undefined) settingsFields.logo = data.logo;
      const cols = { officeName: "office_name", currency: "currency_symbol", theme: "theme", logo: "logo_path" };
      const sets = Object.keys(settingsFields).map((k) => `${cols[k]} = ?`);
      const vals = Object.values(settingsFields);
      if (sets.length) await conn.query(`UPDATE settings SET ${sets.join(", ")} WHERE id = 1`, vals);
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

const DEFAULT_DRIVERS = ["Driver 1", "Driver 2", "Driver 3", "Driver 4", "Driver 5"];
const DEFAULT_SIRS = ["Mr. Rahim", "Mr. Karim", "Mr. Hasan", "Mr. Alam"];
const DEFAULT_FUEL_TYPES = ["Octane", "Petrol", "Diesel"];

// Danger Zone → "Clear All Data": wipes every fuel record (and its history)
// and resets the reference lists back to the starter defaults. Deliberately
// leaves `settings` (office name/logo/currency/theme) and `users` untouched,
// mirroring the original app's behavior.
async function clearAllData() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM approval_history");
    await conn.query("DELETE FROM fuel_records");
    await conn.query("DELETE FROM drivers");
    await conn.query("DELETE FROM office_sirs");
    await conn.query("DELETE FROM fuel_types");
    await conn.query("DELETE FROM stations");

    for (const name of DEFAULT_DRIVERS) await conn.query("INSERT INTO drivers (name) VALUES (?)", [name]);
    for (const name of DEFAULT_SIRS) await conn.query("INSERT INTO office_sirs (name) VALUES (?)", [name]);
    for (const name of DEFAULT_FUEL_TYPES) await conn.query("INSERT INTO fuel_types (name) VALUES (?)", [name]);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { exportBackup, importBackup, clearAllData };
