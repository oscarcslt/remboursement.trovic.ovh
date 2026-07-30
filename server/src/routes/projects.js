const express = require('express');
const { pool } = require('../db/pool');
const { computeProjectView, parseMilestones } = require('../projectStats');

const router = express.Router();
const MAX_PROJECTS = 999;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function notFound(res, message = 'Projet introuvable.') {
  return res.status(404).json({ error: message });
}

function forbidden(res, message = 'Code incorrect.') {
  return res.status(403).json({ error: message });
}

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

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// GET /api/projects
router.get('/', async (req, res, next) => {
  try {
    const includeArchived = req.query.archived === '1';
    const [projects] = await pool.query(
      'SELECT * FROM projects WHERE archived = ? ORDER BY created_at DESC',
      [includeArchived ? 1 : 0]
    );

    const views = await Promise.all(
      projects.map(async (project) => {
        const transactions = await getTransactions(project.id);
        return computeProjectView(project, transactions);
      })
    );

    res.json(views);
  } catch (err) {
    next(err);
  }
});

// GET /api/summary - versements du mois et de la semaine en cours (projets actifs)
router.get('/summary', async (req, res, next) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const dayOfWeek = (now.getDay() + 6) % 7; // lundi = 0
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek);
    startOfWeek.setHours(0, 0, 0, 0);

    const [rows] = await pool.query(
      `SELECT t.amount, t.occurred_at
       FROM transactions t
       JOIN projects p ON p.id = t.project_id
       WHERE t.type = 'versement' AND p.archived = 0 AND t.occurred_at >= ?`,
      [startOfMonth]
    );

    let monthTotal = 0;
    let weekTotal = 0;
    for (const row of rows) {
      const amount = Number(row.amount);
      monthTotal += amount;
      if (new Date(row.occurred_at) >= startOfWeek) weekTotal += amount;
    }

    res.json({
      monthTotal: Math.round(monthTotal * 100) / 100,
      weekTotal: Math.round(weekTotal * 100) / 100
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:id
router.get('/:id', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const transactions = await getTransactions(project.id);
    res.json({
      ...computeProjectView(project, transactions),
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        note: t.note,
        occurredAt: t.occurred_at
      }))
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/projects
router.post('/', async (req, res, next) => {
  try {
    const { name, totalAmount, initialContribution, monthlyBudget, note, secretCode, adminCode, milestones } =
      req.body || {};

    if (!name || typeof name !== 'string' || !name.trim() || name.length > 80) {
      return badRequest(res, 'Le nom du projet est obligatoire (max 80 caractères).');
    }
    if (!isPositiveNumber(totalAmount)) {
      return badRequest(res, 'Le montant total doit être un nombre positif.');
    }
    if (!isPositiveNumber(monthlyBudget)) {
      return badRequest(res, 'Le budget mensuel doit être un nombre positif.');
    }
    const contribution = initialContribution == null ? 0 : Number(initialContribution);
    if (!Number.isFinite(contribution) || contribution < 0) {
      return badRequest(res, "L'apport de départ doit être un nombre positif ou nul.");
    }
    if (note && (typeof note !== 'string' || note.length > 500)) {
      return badRequest(res, 'La note ne doit pas dépasser 500 caractères.');
    }
    if (!secretCode || !String(secretCode).trim()) {
      return badRequest(res, 'Le code maman est obligatoire.');
    }
    if (!adminCode || !String(adminCode).trim()) {
      return badRequest(res, 'Le code Victor est obligatoire.');
    }

    let milestoneList = [25, 50, 75, 100];
    if (Array.isArray(milestones) && milestones.length) {
      const parsed = milestones
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 100)
        .sort((a, b) => a - b);
      if (parsed.length) milestoneList = parsed;
    }

    const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM projects');
    if (count >= MAX_PROJECTS) {
      return badRequest(res, `Limite atteinte : ${MAX_PROJECTS} projets maximum.`);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO projects
          (name, total_amount, monthly_budget, note, secret_code, admin_code, started, paused, archived, milestones)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?)`,
        [
          name.trim(),
          totalAmount,
          monthlyBudget,
          note ? note.trim() : null,
          String(secretCode).trim(),
          String(adminCode).trim(),
          milestoneList.join(',')
        ]
      );
      const projectId = result.insertId;

      await conn.query(
        `INSERT INTO transactions (project_id, type, amount, note) VALUES (?, 'versement', ?, ?)`,
        [projectId, contribution, contribution > 0 ? 'Apport de départ' : null]
      );

      await conn.commit();

      const project = await getProjectRow(projectId);
      const transactions = await getTransactions(projectId);
      res.status(201).json(computeProjectView(project, transactions));
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:id/verify  { role: 'maman' | 'victor', code }
router.post('/:id/verify', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const { role, code } = req.body || {};
    const expected = role === 'victor' ? project.admin_code : role === 'maman' ? project.secret_code : null;
    if (expected === null) return badRequest(res, 'Rôle inconnu.');
    const ok = String(code || '') === String(expected);
    res.json({ ok });
  } catch (err) {
    next(err);
  }
});

function requireCode(project, role, code, res) {
  const expected = role === 'victor' ? project.admin_code : project.secret_code;
  if (String(code || '') !== String(expected)) {
    forbidden(res);
    return false;
  }
  return true;
}

// POST /api/projects/:id/transactions  { amount, note, code }
router.post('/:id/transactions', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const { amount, note, code } = req.body || {};
    if (!requireCode(project, 'victor', code, res)) return;

    if (!isPositiveNumber(amount)) return badRequest(res, 'Le montant doit être un nombre positif.');
    if (note && (typeof note !== 'string' || note.length > 300)) {
      return badRequest(res, 'La note ne doit pas dépasser 300 caractères.');
    }

    const transactions = await getTransactions(project.id);
    const view = computeProjectView(project, transactions);
    const cappedAmount = Math.min(amount, view.remaining);
    if (cappedAmount <= 0) return badRequest(res, 'Le projet est déjà entièrement remboursé.');

    await pool.query(
      `INSERT INTO transactions (project_id, type, amount, note) VALUES (?, 'versement', ?, ?)`,
      [project.id, cappedAmount, note ? note.trim() : null]
    );

    const updatedProject = await getProjectRow(project.id);
    const updatedTransactions = await getTransactions(project.id);
    res.status(201).json(computeProjectView(updatedProject, updatedTransactions));
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:id/settle  { code }  - règle une échéance (budget mensuel ou solde)
router.post('/:id/settle', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const { code } = req.body || {};
    if (!requireCode(project, 'victor', code, res)) return;

    const transactions = await getTransactions(project.id);
    const view = computeProjectView(project, transactions);
    if (view.remaining <= 0) return badRequest(res, 'Le projet est déjà entièrement remboursé.');

    const amount = Math.min(Number(project.monthly_budget), view.remaining);
    await pool.query(
      `INSERT INTO transactions (project_id, type, amount, note) VALUES (?, 'versement', ?, 'Échéance mensuelle')`,
      [project.id, amount]
    );

    const updatedProject = await getProjectRow(project.id);
    const updatedTransactions = await getTransactions(project.id);
    res.status(201).json(computeProjectView(updatedProject, updatedTransactions));
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:id/contest  { motif, code }
router.post('/:id/contest', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const { motif, code } = req.body || {};
    if (!requireCode(project, 'maman', code, res)) return;

    if (!motif || typeof motif !== 'string' || !motif.trim() || motif.length > 300) {
      return badRequest(res, 'Le motif est obligatoire (max 300 caractères).');
    }

    await pool.query(
      `INSERT INTO transactions (project_id, type, amount, note) VALUES (?, 'contestation', 0, ?)`,
      [project.id, motif.trim()]
    );

    const updatedProject = await getProjectRow(project.id);
    const updatedTransactions = await getTransactions(project.id);
    res.status(201).json(computeProjectView(updatedProject, updatedTransactions));
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:id/pause  { code }  - bascule pause / reprise
router.post('/:id/pause', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const { code } = req.body || {};
    if (!requireCode(project, 'victor', code, res)) return;

    await pool.query('UPDATE projects SET paused = ? WHERE id = ?', [project.paused ? 0 : 1, project.id]);

    const updatedProject = await getProjectRow(project.id);
    const updatedTransactions = await getTransactions(project.id);
    res.json(computeProjectView(updatedProject, updatedTransactions));
  } catch (err) {
    next(err);
  }
});

// PUT /api/projects/:id/note  { note, code }
router.put('/:id/note', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const { note, code } = req.body || {};
    if (!requireCode(project, 'victor', code, res)) return;

    if (note && (typeof note !== 'string' || note.length > 500)) {
      return badRequest(res, 'La note ne doit pas dépasser 500 caractères.');
    }

    await pool.query('UPDATE projects SET note = ? WHERE id = ?', [note ? note.trim() : null, project.id]);

    const updatedProject = await getProjectRow(project.id);
    const updatedTransactions = await getTransactions(project.id);
    res.json(computeProjectView(updatedProject, updatedTransactions));
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:id/archive  { code }  - bascule archive / désarchive
router.post('/:id/archive', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const { code } = req.body || {};
    if (!requireCode(project, 'victor', code, res)) return;

    await pool.query('UPDATE projects SET archived = ? WHERE id = ?', [project.archived ? 0 : 1, project.id]);

    const updatedProject = await getProjectRow(project.id);
    const updatedTransactions = await getTransactions(project.id);
    res.json(computeProjectView(updatedProject, updatedTransactions));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:id  { code }
router.delete('/:id', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const { code } = req.body || {};
    if (!requireCode(project, 'victor', code, res)) return;

    await pool.query('DELETE FROM projects WHERE id = ?', [project.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:id/transactions/:txId  { code }
router.delete('/:id/transactions/:txId', async (req, res, next) => {
  try {
    const project = await getProjectRow(req.params.id);
    if (!project) return notFound(res);
    const { code } = req.body || {};
    if (!requireCode(project, 'victor', code, res)) return;

    const [result] = await pool.query('DELETE FROM transactions WHERE id = ? AND project_id = ?', [
      req.params.txId,
      project.id
    ]);
    if (result.affectedRows === 0) return notFound(res, 'Transaction introuvable.');

    const updatedProject = await getProjectRow(project.id);
    const updatedTransactions = await getTransactions(project.id);
    res.json(computeProjectView(updatedProject, updatedTransactions));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
