// server.js — Suivi Réservations · v0.1.4
const express    = require('express');
const path       = require('path');
const db         = require('./sql1');
const guestyAuth = require('./guesty-auth');
const guestyApi  = require('./guesty-api');

const app  = express();
const PORT = 3010;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── S'assurer que la table owners existe ──────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS owners (
    id   TEXT PRIMARY KEY,
    nom  TEXT NOT NULL,
    email TEXT DEFAULT ''
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS listings (
    id       TEXT PRIMARY KEY,
    nom      TEXT NOT NULL,
    owner_id TEXT,
    active   INTEGER DEFAULT 1,
    FOREIGN KEY (owner_id) REFERENCES owners(id)
  )
`);

// ── Pages ─────────────────────────────────────────────────────
app.get('/',                 (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/owners',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'owners.html')));
app.get('/maj-owners',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'maj-owners.html')));
app.get('/listings',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'placeholder.html')));
app.get('/reservations',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'placeholder.html')));
app.get('/maj-reservations', (req, res) => res.sendFile(path.join(__dirname, 'public', 'placeholder.html')));
app.get('/maj-listings',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'placeholder.html')));
app.get('/suivi-prises',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'placeholder.html')));

// ── API — Guesty Token ────────────────────────────────────────
app.get('/api/guesty/status', (req, res) => res.json(guestyAuth.tokenStatus()));

app.get('/api/guesty/token', async (req, res) => {
  try { res.json({ ok: true, token: await guestyAuth.getToken() }); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/guesty/refresh', async (req, res) => {
  try {
    guestyAuth.invalidateToken();
    res.json({ ok: true, token: await guestyAuth.getToken() });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── API — Owners (lecture depuis DB) ─────────────────────────
app.get('/api/owners', (req, res) => {
  try {
    const rows = db.all(`
      SELECT o.id, o.nom, o.email,
             COUNT(l.id) AS nb_listings
      FROM owners o
      LEFT JOIN listings l ON l.owner_id = o.id
      GROUP BY o.id
      ORDER BY o.nom COLLATE NOCASE
    `);
    res.json(rows);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API — Sync Owners depuis Guesty ──────────────────────────
app.post('/api/sync/owners', async (req, res) => {
  try {
    console.log('[SYNC] Démarrage synchronisation owners...');

    // 1. Récupérer owners + listings depuis Guesty
    const [guestyOwners, guestyListings] = await Promise.all([
      guestyApi.getAllOwners(),
      guestyApi.getAllListings(),
    ]);

    // 2. Compter listings par owner dans Guesty
    const countByOwner = {};
    for (const l of guestyListings) {
      const oid = l.ownerId || l.owner?._id;
      if (oid) countByOwner[oid] = (countByOwner[oid] || 0) + 1;
    }

    // 3. Construire map des owners Guesty
    const guestyMap = {};
    for (const o of guestyOwners) {
      const id  = o._id || o.id;
      const nom = [o.firstName, o.lastName].filter(Boolean).join(' ')
                  || o.fullName || o.name || '—';
      guestyMap[id] = { id, nom, email: o.email || '' };
    }

    // 4. Owners actuellement en DB
    const dbOwners = db.all('SELECT id, nom FROM owners');
    const dbMap    = {};
    for (const o of dbOwners) dbMap[o.id] = o;

    const rapport = { ajoutes: [], supprimes: [], inchanges: 0 };

    // 5. Ajouter / mettre à jour
    const upsert = db.prepare(
      'INSERT INTO owners (id, nom, email) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET nom=excluded.nom, email=excluded.email'
    );
    for (const [id, o] of Object.entries(guestyMap)) {
      upsert.run(o.id, o.nom, o.email);
      if (!dbMap[id]) {
        rapport.ajoutes.push(o.nom);
      } else {
        rapport.inchanges++;
      }
    }

    // 6. Supprimer ceux qui ne sont plus dans Guesty
    const del = db.prepare('DELETE FROM owners WHERE id = ?');
    for (const id of Object.keys(dbMap)) {
      if (!guestyMap[id]) {
        rapport.supprimes.push(dbMap[id].nom);
        del.run(id);
      }
    }

    // 7. Synchroniser aussi les listings (pour le comptage)
    const upsertL = db.prepare(
      'INSERT INTO listings (id, nom, owner_id, active) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET nom=excluded.nom, owner_id=excluded.owner_id, active=excluded.active'
    );
    for (const l of guestyListings) {
      const oid = l.ownerId || l.owner?._id || null;
      upsertL.run(l._id || l.id, l.nickname || l.title || l.name || '—', oid, l.active ? 1 : 0);
    }

    console.log(`[SYNC] +${rapport.ajoutes.length} -${rapport.supprimes.length} =${rapport.inchanges}`);
    res.json({ ok: true, rapport });

  } catch(e) {
    console.error('[SYNC] Erreur :', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Démarrage ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✔  Suivi Réservations v0.1.4 — http://localhost:${PORT}`);
  console.log(`   Réseau local         — http://Black6:${PORT}`);
});

// ── API — Sync Owners depuis Guesty → DB locale ───────────────
app.post('/api/owners/sync', async (req, res) => {
  try {
    console.log('[SYNC] Synchronisation owners depuis Guesty...');

    const [owners, listings] = await Promise.all([
      guestyApi.getAllOwners(),
      guestyApi.getAllListings(),
    ]);

    // Compter listings par owner
    const countByOwner = {};
    for (const l of listings) {
      const oid = l.ownerId || l.owner?._id;
      if (oid) countByOwner[oid] = (countByOwner[oid] || 0) + 1;
    }

    // Upsert dans la DB locale
    const upsert = db.prepare(`
      INSERT INTO owners (id, nom)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET nom = excluded.nom
    `);

    let inserted = 0, updated = 0;

    const syncAll = db.transaction(() => {
      for (const o of owners) {
        const id  = o._id || o.id;
        const nom = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.fullName || o.name || '—';
        const existing = db.get('SELECT id FROM owners WHERE id = ?', [id]);
        upsert.run(id, nom);
        if (existing) updated++; else inserted++;
      }
    });
    syncAll();

    console.log(`[SYNC] ${inserted} ajoutés, ${updated} mis à jour`);
    res.json({ ok: true, total: owners.length, inserted, updated });

  } catch (e) {
    console.error('[SYNC] Erreur :', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
