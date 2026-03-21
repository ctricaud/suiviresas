# Suivi Réservations — v0.1.0

## Installation (une seule fois)

```bash
npm install
```

Aucune compilation native requise — `node-sqlite3-wasm` est 100% JavaScript.

## Démarrage

```bash
node server.js
```

Puis ouvrir : http://localhost:3010  
Réseau local : http://Black6:3010

## PM2 (démarrage automatique)

```bash
pm2 start server.js --name "suivi-reservations"
pm2 save
pm2 startup
```

## Structure

```
suivi-reservations/
├── server.js          ← Express, port 3010
├── sql1.js            ← Instance SQLite partagée (node-sqlite3-wasm)
├── package.json
├── reservations.db    ← Base SQLite (à créer via init-db.js)
└── public/
    └── index.html     ← Page d'accueil
```

## Note sur la base de données

`node-sqlite3-wasm` a une API légèrement différente de `better-sqlite3` :
- `db.run(sql)` au lieu de `db.pragma(sql)`  
- `db.get(sql)` retourne directement la ligne  
- `db.all(sql)` retourne toutes les lignes  
Tout reste synchrone, pas de callbacks, pas de promises.
