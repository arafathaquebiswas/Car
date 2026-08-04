const pool = require("../config/db");

// drivers, office_sirs, fuel_types, and stations are all the same shape —
// { id, name, created_at } with a unique name — so one factory builds the
// query functions for all four instead of copy-pasting four near-identical
// model files.
function createSimpleListModel(tableName) {
  // `tableName` is always a hardcoded constant supplied by the developer at
  // startup (see driverRoutes.js etc.) — never user input — so interpolating
  // it directly is safe. Every actual value (name, id) still goes through a
  // parameterized `?` placeholder below.
  return {
    async getAll() {
      const [rows] = await pool.query(`SELECT id, name, created_at FROM ${tableName} ORDER BY name ASC`);
      return rows;
    },
    async findById(id) {
      const [rows] = await pool.query(`SELECT id, name FROM ${tableName} WHERE id = ? LIMIT 1`, [id]);
      return rows[0] || null;
    },
    async findByName(name) {
      const [rows] = await pool.query(`SELECT id, name FROM ${tableName} WHERE name = ? LIMIT 1`, [name]);
      return rows[0] || null;
    },
    async create(name) {
      const [result] = await pool.query(`INSERT INTO ${tableName} (name) VALUES (?)`, [name]);
      return { id: result.insertId, name };
    },
    async remove(id) {
      await pool.query(`DELETE FROM ${tableName} WHERE id = ?`, [id]);
    },
  };
}

module.exports = { createSimpleListModel };
