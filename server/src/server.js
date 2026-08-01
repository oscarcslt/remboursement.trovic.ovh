require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const { waitForDatabase } = require('./db/pool');
const projectsRouter = require('./routes/projects');
const { router: invitationsRouter } = require('./routes/invitations');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

app.use(cors());
app.use(express.json({ limit: '200kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/projects', projectsRouter);
app.use('/api/invitations', invitationsRouter);

app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

async function start() {
  await waitForDatabase();
  app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Impossible de démarrer le serveur :', err);
  process.exit(1);
});
