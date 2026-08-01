const nodemailer = require('nodemailer');

function isConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

let transporter = null;
function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined
    });
  }
  return transporter;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function sendMamanInvitation({ to, projectName, totalAmount, inviteLink }) {
  const t = getTransporter();
  if (!t) return { sent: false, reason: 'smtp_not_configured' };

  const from = process.env.SMTP_FROM || 'Suivi remboursement <no-reply@trovic.ovh>';
  const subject = `Victor t'invite à suivre le remboursement « ${projectName} »`;
  const text = `Bonjour,

Victor a créé un projet de remboursement intitulé « ${projectName} » (${totalAmount} €) sur Suivi remboursement, pour que tu puisses suivre l'avancement des versements en toute transparence et signaler une contestation si besoin.

Pour y accéder, commence par définir ton code d'accès personnel :
${inviteLink}

Ce lien est valable 14 jours.

À bientôt,
Suivi remboursement`;

  const html = `
    <div style="font-family:sans-serif;color:#172235;line-height:1.6;">
      <p>Bonjour,</p>
      <p>Victor a créé un projet de remboursement intitulé « <strong>${escapeHtml(projectName)}</strong> »
      (${escapeHtml(totalAmount)} €) sur <strong>Suivi remboursement</strong>, pour que tu puisses suivre
      l'avancement des versements en toute transparence et signaler une contestation si besoin.</p>
      <p>Pour y accéder, commence par définir ton code d'accès personnel :</p>
      <p>
        <a href="${escapeHtml(inviteLink)}"
           style="display:inline-block;background:#176b68;color:#ffffff;padding:10px 20px;
                  border-radius:12px;text-decoration:none;font-weight:600;">
          Définir mon code d'accès
        </a>
      </p>
      <p style="font-size:13px;color:#687384;">Ou copie ce lien dans ton navigateur :<br>
        <a href="${escapeHtml(inviteLink)}">${escapeHtml(inviteLink)}</a></p>
      <p style="font-size:13px;color:#687384;">Ce lien est valable 14 jours.</p>
      <p>À bientôt,<br>Suivi remboursement</p>
    </div>`;

  try {
    await t.sendMail({ from, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    console.error("Échec de l'envoi de l'e-mail d'invitation :", err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

module.exports = { sendMamanInvitation, isConfigured };
