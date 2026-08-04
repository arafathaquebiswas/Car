// Generates the next FS-0001-style record code by looking at the highest
// existing numeric suffix already stored. Simpler than a separate counter
// table, and self-healing if rows are ever deleted out of order.
async function nextRecordCode(pool) {
  const [rows] = await pool.query(
    "SELECT record_code FROM fuel_records ORDER BY id DESC LIMIT 1"
  );
  let next = 1;
  if (rows.length) {
    const match = /FS-(\d+)/.exec(rows[0].record_code);
    if (match) next = parseInt(match[1], 10) + 1;
  }
  return "FS-" + String(next).padStart(4, "0");
}

module.exports = { nextRecordCode };
