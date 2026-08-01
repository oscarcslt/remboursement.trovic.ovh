const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { sendMamanInvitation } = require('../mailer');

const router = express.Router();
const INVITE_EXPIRY_DAYS = 14;

function buildInviteLink(token) {
  const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/?invite=${token}`;
}

async function createAndSendInvite(project) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  await pool.query('UPDATE projects SET invite_token = ?, invite_token_expires_at = ? WHERE id = ?', [
    token,
    expiresAt,
    project.id
  ]);
  const inviteLink = buildInviteLink(token);
  const result = await sendMamanInvitation({
    to: project.maman_email,
    projectName: project.name,
    totalAmount: Number(project.total_amount).toFixed(2),
    inviteLink
  });
  return { ...result, inviteLink };
}

// GET /api/invitations/:token
router.get('/:token', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, total_amount, invite_token_expires_at FROM projects WHERE invite_token = ?',
      [req.params.token]
    );
    const project = rows[0];
    if (!project) {
      return res.status(404).json({ error: "Ce lien d'invitation est introuvable ou a déjà été utilisé." });
    }
    if (new Date(project.invite_token_expires_at) < new Date()) {
      return res.status(410).json({ error: "Ce lien d'invitation a expiré. Demande à Victor de t'en renvoyer un." });
    }
    res.json({ projectId: project.id, projectName: project.name, totalAmount: Number(project.total_amount) });
  } catch (err) {
    next(err);
  }
});

// POST /api/invitations/:token  { code }
router.post('/:token', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM projects WHERE invite_token = ?', [req.params.token]);
    const project = rows[0];
    if (!project) {
      return res.status(404).json({ error: "Ce lien d'invitation est introuvable ou a déjà été utilisé." });
    }
    if (new Date(project.invite_token_expires_at) < new Date()) {
      return res.status(410).json({ error: "Ce lien d'invitation a expiré. Demande à Victor de t'en renvoyer un." });
    }

    const { code } = req.body || {};
    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: 'Choisis un code non vide.' });
    }

    await pool.query(
      'UPDATE projects SET secret_code = ?, invite_token = NULL, invite_token_expires_at = NULL WHERE id = ?',
      [String(code).trim(), project.id]
    );

    res.json({ ok: true, projectId: project.id });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, createAndSendInvite };
