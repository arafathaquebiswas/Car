// MySQL connection pool. Every query in the app goes through this pool
// using parameterized queries (mysql2's `?` placeholders) — never string
// concatenation — so user input can never become part of the SQL text.
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "fuel_station",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 5,
  queueLimit: 0,
  dateStrings: true, // return DATE/DATETIME as plain strings, not JS Date objects
});

// Without this listener, a lost IDLE connection (MySQL restarting for
// maintenance, a brief network blip, the server's wait_timeout closing a
// connection nobody was actively using) fires an 'error' event on the pool
// with no listener attached, which Node treats as an uncaught exception and
// crashes the entire process — taking the whole office's app down until
// someone notices and restarts it. Active queries already get their own
// rejected promise regardless; this only stops idle-connection errors from
// being fatal.
pool.on("error", (err) => {
  console.error("MySQL pool error (recovered, connection will be re-established):", err.message);
});

module.exports = pool;
