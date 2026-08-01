# Suivi remboursement

Application web (SPA) de suivi de remboursements familiaux : Victor crée et
alimente des projets de remboursement, Maman peut consulter l'avancement et
signaler une contestation. Chaque mode est protégé par un code défini à la
création du projet.

## Stack

- **Frontend** : HTML/CSS/JS pur (aucun build), Tailwind CSS (Play CDN),
  icônes Lucide, polices DM Sans / Fraunces. Servi en statique par l'API.
- **Backend** : Node.js + Express (`server/`).
- **Base de données** : MariaDB (conteneur Docker), schéma dans `db/init.sql`.
- **Orchestration** : Docker Compose (`docker-compose.yml`).

## Démarrage

```bash
cp .env.example .env
# éditer .env : mots de passe, port exposé, APP_BASE_URL et SMTP_* (voir
# la section "Invitation de maman par e-mail" ci-dessous)
docker compose up -d --build
```

L'application est ensuite disponible sur `http://localhost` (ou le port
défini par `APP_PORT`).

Le schéma SQL (`db/init.sql`) est chargé automatiquement au premier démarrage
du conteneur MariaDB (volume `db_data` vide).

## Arrêt / réinitialisation

```bash
docker compose down          # arrête les conteneurs, conserve les données
docker compose down -v       # arrête et supprime aussi la base de données
```

## Structure du projet

```
db/init.sql                schéma MariaDB (projects, transactions)
server/                    API Express (Node.js)
  src/server.js             point d'entrée, sert aussi le frontend statique
  src/db/pool.js             pool de connexions MariaDB
  src/db/repo.js             accès BDD partagé (projets, transactions)
  src/mailer.js              envoi de l'e-mail d'invitation (SMTP via nodemailer)
  src/projectStats.js        calculs dérivés (statut, progression, retard...)
  src/routes/projects.js     routes API projets/transactions
  src/routes/invitations.js  routes API d'activation du code maman
public/                    frontend statique (SPA)
  index.html
  css/styles.css
  js/app.js
docker-compose.yml
```

## Modèle de données

**projects** : nom, montant total, budget mensuel, note, `admin_code`
(Victor, saisi à la création), `secret_code` (maman, `NULL` tant qu'elle n'a
pas activé son accès), `maman_email`, `invite_token` /
`invite_token_expires_at` (invitation en cours), état (démarré / pause /
archivé), jalons personnalisés.

**transactions** : rattachées à un projet, de type `versement` ou
`contestation`, avec montant, note et date. Le statut du projet (en cours,
en pause, terminé, contesté, à relancer) est recalculé à la volée à partir de
l'historique — un projet est « contesté » tant qu'il porte au moins une
transaction de type contestation.

## Codes d'accès

Le code Victor est saisi directement par Victor à la création du projet.
Le code maman n'est jamais saisi par Victor : à la création, Victor renseigne
seulement l'e-mail de maman, ce qui déclenche l'envoi d'une invitation (voir
ci-dessous) — c'est maman qui choisit elle-même son code en cliquant sur le
lien reçu.

Les codes sont vérifiés côté serveur à chaque action sensible (ajout de
versement, contestation, pause, archivage, suppression...). Une fois validé
dans l'interface, le code est conservé en mémoire le temps de la session pour
éviter de le ressaisir à chaque action, mais reste requis par l'API pour
toute opération protégée.

## Invitation de maman par e-mail

À la création d'un projet (ou via « Renvoyer l'invitation » dans Réglage
Victor), le serveur génère un lien à usage unique
(`APP_BASE_URL/?invite=<token>`, valable 14 jours) et tente d'envoyer un
e-mail à l'adresse renseignée, expliquant le projet et invitant maman à
définir son propre code. En cliquant sur le lien, elle arrive sur un écran
dédié pour choisir son code, puis accède directement au projet en mode
« Réglage maman ».

Configuration SMTP (variables `.env`, service `api`) :

```
APP_BASE_URL=https://remboursement.trovic.ovh
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=Suivi remboursement <no-reply@trovic.ovh>
```

Si `SMTP_HOST` est laissé vide, aucun e-mail n'est envoyé : l'interface
affiche alors le lien d'invitation dans une fenêtre pour que Victor puisse le
transmettre lui-même (utile en développement, ou en secours si l'envoi
échoue).

## Notes de test

L'ensemble des routes de l'API et le parcours frontend complet (création de
projet, versement, règlement d'échéance, contestation, pause, archivage,
codes d'accès corrects/incorrects, export CSV, recherche/filtre) ont été
validés manuellement contre une instance MariaDB réelle pendant le
développement. Le pipeline `docker compose build` n'a pas pu être exécuté
dans l'environnement de développement (accès registre Docker Hub restreint
par la politique réseau du bac à sable) ; `docker compose config` a été
utilisé pour valider la syntaxe du fichier `docker-compose.yml`.
