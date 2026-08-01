const { pool } = require('./pool');

async function getProjectRow(id) {
  const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getTransactions(projectId) {
  const [rows] = await pool.query(
    'SELECT * FROM transactions WHERE project_id = ? ORDER BY occurred_at DESC, id DESC',
    [projectId]
  );
  return rows;
}

module.exports = { getProjectRow, getTransactions };
