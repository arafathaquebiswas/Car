// Runs once at server startup. If the `users` table is empty, creates the
// initial admin account from .env (SEED_ADMIN_*) using a real bcrypt hash —
// this is why the hash isn't baked into database/fuel_station.sql.
const bcrypt = require("bcryptjs");
const pool = require("./db");

const SALT_ROUNDS = 10;

async function seedAdminUser() {
  const [rows] = await pool.query("SELECT COUNT(*) AS count FROM users");
  if (rows[0].count > 0) return; // already seeded (or an admin was created since)

  const username = process.env.SEED_ADMIN_USERNAME || "admin";
  const password = process.env.SEED_ADMIN_PASSWORD || "admin123";
  const fullName = process.env.SEED_ADMIN_NAME || "Administrator";

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await pool.query(
    "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, 'admin')",
    [username, passwordHash, fullName]
  );

  console.log(`Seeded initial admin user "${username}" (from .env SEED_ADMIN_* values).`);
}

module.exports = { seedAdminUser, SALT_ROUNDS };
