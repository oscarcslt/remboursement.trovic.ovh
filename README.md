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
# éditer .env si besoin (mots de passe, port exposé)
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
db/init.sql            schéma MariaDB (projects, transactions)
server/                API Express (Node.js)
  src/server.js         point d'entrée, sert aussi le frontend statique
  src/db/pool.js         pool de connexions MariaDB
  src/projectStats.js    calculs dérivés (statut, progression, retard...)
  src/routes/projects.js routes API
public/                 frontend statique (SPA)
  index.html
  css/styles.css
  js/app.js
docker-compose.yml
```

## Modèle de données

**projects** : nom, montant total, budget mensuel, note, `secret_code`
(maman), `admin_code` (Victor), état (démarré / pause / archivé), jalons
personnalisés.

**transactions** : rattachées à un projet, de type `versement` ou
`contestation`, avec montant, note et date. Le statut du projet (en cours,
en pause, terminé, contesté, à relancer) est recalculé à la volée à partir de
l'historique — un projet est « contesté » tant qu'il porte au moins une
transaction de type contestation.

## Codes d'accès

Les codes maman/Victor sont saisis à la création du projet et vérifiés côté
serveur à chaque action sensible (ajout de versement, contestation, pause,
archivage, suppression...). Une fois validé dans l'interface, le code est
conservé en mémoire le temps de la session pour éviter de le ressaisir à
chaque action, mais reste requis par l'API pour toute opération protégée.

## Notes de test

L'ensemble des routes de l'API et le parcours frontend complet (création de
projet, versement, règlement d'échéance, contestation, pause, archivage,
codes d'accès corrects/incorrects, export CSV, recherche/filtre) ont été
validés manuellement contre une instance MariaDB réelle pendant le
développement. Le pipeline `docker compose build` n'a pas pu être exécuté
dans l'environnement de développement (accès registre Docker Hub restreint
par la politique réseau du bac à sable) ; `docker compose config` a été
utilisé pour valider la syntaxe du fichier `docker-compose.yml`.
