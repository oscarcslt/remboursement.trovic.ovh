const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'reimburse',
  password: process.env.DB_PASSWORD || 'reimburse',
  database: process.env.DB_NAME || 'reimbursement',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true
});

async function waitForDatabase(retries = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const conn = await pool.getConnection();
      conn.release();
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = { pool, waitForDatabase };
