const pool = require("../config/db");
const ApiError = require("../utils/ApiError");

// Formats "2026-07" as "July 2026" for the report label — matches what the
// original client-side version showed before reports moved server-side.
function monthLabel(month) {
  const [y, m] = month.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// Builds a safe, parameterized WHERE clause for the report types.
// Every value is bound as a `?` placeholder — never concatenated — so
// query params can't be used for SQL injection.
function buildFilter(query) {
  const { type } = query;
  const where = ["r.is_draft = 0"]; // reports are about completed fuel activity, not in-progress drafts
  const params = [];
  let label;
  let filename;

  if (type === "range") {
    const { from, to } = query;
    if (from) { where.push("r.record_date >= ?"); params.push(from); }
    if (to) { where.push("r.record_date <= ?"); params.push(to); }
    label = `Date Range Report (${from || "Start"} – ${to || "Today"})`;
    filename = `date-range-report-${from || "start"}_${to || "end"}`;
  } else if (type === "driver") {
    const { driver } = query;
    if (driver) { where.push("d.name = ?"); params.push(driver); }
    label = `Driver Report — ${driver || "All Drivers"}`;
    filename = `driver-report-${driver || "all"}`;
  } else if (type === "vehicle") {
    const { vehicle } = query;
    if (vehicle) { where.push("r.vehicle_number = ?"); params.push(vehicle); }
    label = `Vehicle Report — ${vehicle || "All Vehicles"}`;
    filename = `vehicle-report-${vehicle || "all"}`;
  } else if (type === "station") {
    const { station } = query;
    if (station) { where.push("r.station_name = ?"); params.push(station); }
    label = `Fuel Station Report — ${station || "All Stations"}`;
    filename = `station-report-${station || "all"}`;
  } else {
    // monthly (default) — local month, not UTC (see recordModel.js's
    // validatePayload() for why: UTC can be a day/month behind local time).
    const now = new Date();
    const localMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const month = query.month || localMonth;
    where.push("DATE_FORMAT(r.record_date, '%Y-%m') = ?");
    params.push(month);
    label = `Monthly Report — ${monthLabel(month)}`;
    filename = `monthly-report-${month}`;
  }

  return { whereSql: where.join(" AND "), params, label, filename };
}

async function getReport(query) {
  if (!["monthly", "range", "driver", "vehicle", "station"].includes(query.type || "monthly")) {
    throw new ApiError(400, "Invalid report type.");
  }
  const { whereSql, params, label, filename } = buildFilter(query);

  // LEFT JOIN office_sirs — the request form no longer collects an "Office
  // Sir", so sir_id is null on virtually every record going forward. An
  // inner join here would silently exclude every new record from every
  // report the moment that field disappeared.
  const [matched] = await pool.query(
    `SELECT
       r.id, r.record_code AS id_code, r.record_date, d.name AS driver_name,
       r.vehicle_number, r.station_name, ft.name AS fuel_type_name, r.liters, r.total_amount,
       r.approval_status, r.is_draft, r.machine_photo_reviewed, r.money_receipt_reviewed,
       r.fuel_received, r.is_locked,
       r.fuel_receipt_image, r.money_receipt_image
     FROM fuel_records r
     JOIN drivers d ON d.id = r.driver_id
     LEFT JOIN fuel_types ft ON ft.id = r.fuel_type_id
     WHERE ${whereSql}
     ORDER BY r.record_date DESC, r.id DESC`,
    params
  );

  const [byDriverRows] = await pool.query(
    `SELECT d.name AS label, COUNT(*) AS records, SUM(r.liters) AS liters, SUM(r.total_amount) AS cost
     FROM fuel_records r JOIN drivers d ON d.id = r.driver_id
     WHERE ${whereSql}
     GROUP BY d.name ORDER BY d.name`,
    params
  );

  const [byFuelTypeRows] = await pool.query(
    `SELECT ft.name AS label, COUNT(*) AS records, SUM(r.liters) AS liters, SUM(r.total_amount) AS cost
     FROM fuel_records r JOIN drivers d ON d.id = r.driver_id
     LEFT JOIN fuel_types ft ON ft.id = r.fuel_type_id
     WHERE ${whereSql}
     GROUP BY ft.name ORDER BY ft.name`,
    params
  );

  const [[totals]] = await pool.query(
    `SELECT COUNT(*) AS records, COALESCE(SUM(r.liters),0) AS liters, COALESCE(SUM(r.total_amount),0) AS cost
     FROM fuel_records r JOIN drivers d ON d.id = r.driver_id
     WHERE ${whereSql}`,
    params
  );

  const toBreakdown = (rows) => {
    const out = {};
    rows.forEach((r) => { out[r.label] = { records: r.records, liters: Number(r.liters), cost: Number(r.cost) }; });
    return out;
  };

  return {
    label,
    filename,
    totalRecords: totals.records,
    totalLiters: Number(totals.liters),
    totalCost: Number(totals.cost),
    byDriver: toBreakdown(byDriverRows),
    byFuelType: toBreakdown(byFuelTypeRows),
    matched: matched.map((r) => ({
      id: r.id_code,
      date: r.record_date,
      driver: r.driver_name,
      vehicleNumber: r.vehicle_number,
      stationName: r.station_name,
      fuelType: r.fuel_type_name,
      liters: Number(r.liters),
      totalAmount: Number(r.total_amount),
      approvalStatus: r.approval_status,
      isDraft: !!r.is_draft,
      reviewedForApproval: !!(r.machine_photo_reviewed && r.money_receipt_reviewed),
      fuelReceived: r.fuel_received,
      locked: !!r.is_locked,
      // Indicators for whether each mandatory photo was uploaded at all
      // (independent of whether it's been reviewed yet).
      hasMachinePhoto: !!r.fuel_receipt_image,
      hasMoneyReceipt: !!r.money_receipt_image,
      // The actual paths too — needed client-side to embed thumbnails in
      // the exported report PDF, not just show a Yes/No indicator.
      fuelReceiptImage: r.fuel_receipt_image,
      moneyReceiptImage: r.money_receipt_image,
    })),
  };
}

module.exports = { getReport };
