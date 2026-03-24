// server.js — Suivi Réservations · v0.1.5
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

// ── Tables ────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS owners (
    id  TEXT PRIMARY KEY,
    nom TEXT NOT NULL
  )
`);

// Migration : suppression colonne email si elle existe encore
try { db.run('ALTER TABLE owners DROP COLUMN email'); } catch(e) { /* colonne déjà absente */ }

db.run(`
  CREATE TABLE IF NOT EXISTS listings (
    id           TEXT PRIMARY KEY,
    nom          TEXT NOT NULL,
    commission   REAL,
    cleaning_fee TEXT,
    owner_id     TEXT,
    active       INTEGER DEFAULT 1,
    FOREIGN KEY (owner_id) REFERENCES owners(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS reservations (
    id                 TEXT PRIMARY KEY,
    confirmation_code  TEXT,
    listing_id         TEXT,
    platform           TEXT,
    status             TEXT NOT NULL DEFAULT 'confirmed',
    check_in           TEXT,
    check_out          TEXT,
    nights             INTEGER,
    guest_name         TEXT,
    confirmed_at       TEXT,
    fare_accommodation REAL,
    fare_cleaning      REAL,
    channel_commission REAL,
    total_paid         REAL,
    payment_fees       REAL,
    FOREIGN KEY (listing_id) REFERENCES listings(id)
  )
`);

// Migrations colonnes listings (ajouts post v0.1.5)
try { db.run('ALTER TABLE listings ADD COLUMN commission REAL'); }   catch(e) { /* déjà présente */ }
try { db.run('ALTER TABLE listings ADD COLUMN cleaning_fee TEXT'); } catch(e) { /* déjà présente */ }

// Migrations colonnes reservations
try { db.run('ALTER TABLE reservations ADD COLUMN fare_accommodation REAL'); } catch(e) { /* déjà présente */ }
try { db.run('ALTER TABLE reservations ADD COLUMN owner_payout REAL'); }      catch(e) { /* déjà présente */ }
try { db.run('ALTER TABLE reservations ADD COLUMN pm_revenue REAL'); }        catch(e) { /* déjà présente */ }
// Suppression owner_revenue (désormais stocké dans owner_payout)
try { db.run('ALTER TABLE reservations DROP COLUMN owner_revenue'); } catch(e) { /* absente ou non supporté */ }

// ── Recalcul versements & frais conciergerie ──────────────────
// Formules (alignées VBA) :
//   owner_payout = (fareAccommodation − fraisChannel) × (1 − commission%)
//   pm_revenue   = total_client − fraisChannel − owner_payout
//                = ménage + commission% × (fareAccommodation − fraisChannel)
// Appelé après chaque sync pour mettre à jour les réservations ayant des données financières.
function recalculatePayouts() {
  db.run(`
    UPDATE reservations SET
      owner_payout = (
        SELECT CASE WHEN l.commission IS NOT NULL AND reservations.fare_accommodation IS NOT NULL
          THEN ROUND(
            (reservations.fare_accommodation
             - COALESCE(reservations.channel_commission, 0)
             - COALESCE(reservations.payment_fees, 0))
            * (1.0 - l.commission / 100.0), 2)
          ELSE NULL END
        FROM listings l WHERE l.id = reservations.listing_id
      ),
      pm_revenue = (
        SELECT CASE WHEN l.commission IS NOT NULL AND reservations.fare_accommodation IS NOT NULL
          THEN ROUND(
            COALESCE(reservations.fare_cleaning, 0)
            + (l.commission / 100.0)
            * (reservations.fare_accommodation
               - COALESCE(reservations.channel_commission, 0)
               - COALESCE(reservations.payment_fees, 0)),
            2)
          ELSE NULL END
        FROM listings l WHERE l.id = reservations.listing_id
      )
  `);
}

// ── Pages ─────────────────────────────────────────────────────
app.get('/',                 (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/owners',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'owners.html')));
app.get('/maj-owners',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'maj-owners.html')));
app.get('/listings',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'listings.html')));
app.get('/maj-listings',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'maj-listings.html')));
app.get('/reservations',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'reservations.html')));
app.get('/maj-reservations', (req, res) => res.sendFile(path.join(__dirname, 'public', 'maj-reservations.html')));
app.get('/suivi-prises',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'placeholder.html')));

// ── API — Réservations (lecture DB) ──────────────────────────
app.get('/api/reservations', (req, res) => {
  try {
    const { listing_id, owner_id, status } = req.query;
    let sql = `
      SELECT r.id, r.confirmation_code, r.listing_id, r.platform, r.status,
             r.check_in, r.check_out, r.nights, r.guest_name, r.confirmed_at,
             r.fare_accommodation, r.fare_cleaning, r.channel_commission,
             r.payment_fees, r.total_paid,
             r.owner_payout,
             r.pm_revenue,
             CASE WHEN r.fare_accommodation IS NOT NULL
               THEN ROUND(r.fare_accommodation + COALESCE(r.fare_cleaning, 0), 2)
               ELSE NULL
             END AS total_client,
             CASE WHEN r.channel_commission IS NOT NULL OR r.payment_fees IS NOT NULL
               THEN ROUND(COALESCE(r.channel_commission, 0) + COALESCE(r.payment_fees, 0), 2)
               ELSE NULL
             END AS frais_plateforme,
             l.nom      AS listing_nom,
             l.owner_id AS owner_id,
             o.nom      AS owner_nom
      FROM reservations r
      LEFT JOIN listings l ON l.id = r.listing_id
      LEFT JOIN owners   o ON o.id = l.owner_id
    `;
    const conditions = [], params = [];
    if (listing_id) { conditions.push('r.listing_id = ?'); params.push(listing_id); }
    if (owner_id)   { conditions.push('l.owner_id = ?');   params.push(owner_id); }
    if (status)     { conditions.push('r.status = ?');     params.push(status); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY r.check_in DESC';
    res.json(db.all(sql, params));
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API — Sync Réservations depuis Guesty ─────────────────────
//
//   POST /api/reservations/sync             → à venir uniquement (rapide)
//   POST /api/reservations/sync?full=true   → historique complet (boucle par listing)
//   POST /api/reservations/sync?force=true  → historique complet + refetch détails existants
//
//  Stratégie historique complet :
//    On boucle sur chaque listing de la DB et on appelle Guesty par listing.
//    C'est la seule façon d'obtenir toutes les réservations : sans filtre listingId,
//    l'API Guesty applique une fenêtre temporelle et renvoie ~350 résultats max.
//
app.post('/api/reservations/sync', async (req, res) => {
  const full  = req.query.full  === 'true';
  const force = req.query.force === 'true';

  try {
    // ── 1. Récupérer les résumés depuis Guesty ──────────────
    let summaries = [];

    if (!full && !force) {
      // Mode rapide : réservations à venir uniquement
      console.log('[SYNC RESAS] Mode à venir...');
      summaries = await guestyApi.getUpcomingReservations();
      console.log(`[SYNC RESAS] ${summaries.length} réservations à venir`);

    } else {
      // Mode historique : boucle sur chaque listing actif de la DB
      const listings = db.all('SELECT id FROM listings WHERE active = 1');
      if (!listings.length) {
        return res.status(400).json({ ok: false, error: 'Aucun listing en DB. Lancez d\'abord la sync des listings.' });
      }
      console.log(`[SYNC RESAS] Mode historique — ${listings.length} listings à traiter...`);

      const seen = new Set();
      for (const { id: listingId } of listings) {
        try {
          const resas = await guestyApi.getReservationsByListing(listingId);
          for (const r of resas) {
            const id = r._id || r.id;
            if (id && !seen.has(id)) { seen.add(id); summaries.push(r); }
          }
        } catch(e) {
          console.error(`[SYNC RESAS] Erreur listing ${listingId} :`, e.message);
        }
      }
      console.log(`[SYNC RESAS] ${summaries.length} réservations au total`);
    }

    // ── 2. Comparer avec la DB ──────────────────────────────
    const guestyMap = {};
    for (const r of summaries) {
      const id = r._id || r.id;
      if (id) guestyMap[id] = r;
    }

    // On charge id + status + fare_accommodation pour décider quoi fetcher
    const dbResas = db.all('SELECT id, status, fare_accommodation FROM reservations');
    const dbMap   = {};
    for (const r of dbResas) dbMap[r.id] = r;

    // Nouvelles réservations → toujours fetcher le détail
    // Force → fetcher seulement celles qui n'ont pas encore de données financières
    const toFetch = Object.keys(guestyMap).filter(id =>
      !dbMap[id] ||                                              // nouvelle
      (force && dbMap[id].fare_accommodation === null)           // force + financiers manquants
    );
    // Statut changé → update sans re-fetch
    const toStatus = Object.keys(guestyMap).filter(id =>
      dbMap[id] && !toFetch.includes(id) &&
      guestyMap[id].status &&
      dbMap[id].status !== guestyMap[id].status
    );
    const ignores = Object.keys(guestyMap).length - toFetch.length - toStatus.length;
    const rapport = { fetched: summaries.length, ajoutes: 0, mis_a_jour: 0, statuts: toStatus.length, ignores, erreurs: 0 };

    console.log(`[SYNC RESAS] à fetcher=${toFetch.length} statuts=${toStatus.length} ignorés=${ignores}`);

    // ── 3. Fetch détails financiers ─────────────────────────
    // Les données de BASE (status, listingId, platform…) viennent du résumé.
    // Le détail fournit uniquement les données financières + guest.fullName + confirmed_at.
    // Gestion 429 : pause de PAUSE_429_MS puis reprise (max MAX_RETRIES tentatives).
    const sleep      = ms => new Promise(r => setTimeout(r, ms));
    const DELAY_MS   = 300;   // ~3 appels/seconde entre chaque réservation
    const PAUSE_429  = 30000; // 30s de pause en cas de rate limit Guesty
    const MAX_RETRY  = 5;     // tentatives max par réservation

    const details = [];
    for (const id of toFetch) {
      await sleep(DELAY_MS);

      let detail   = null;
      let attempts = 0;
      let failed   = false;

      while (attempts < MAX_RETRY) {
        try {
          detail = await guestyApi.getReservation(id);
          break; // succès
        } catch(e) {
          if (e.message.includes('429')) {
            attempts++;
            console.warn(`[SYNC RESAS] 429 — pause ${PAUSE_429 / 1000}s puis reprise (tentative ${attempts}/${MAX_RETRY})`);
            await sleep(PAUSE_429);
          } else {
            // Erreur non-429 : on n'insiste pas
            console.error(`[SYNC RESAS] Erreur détail ${id} :`, e.message);
            failed = true;
            break;
          }
        }
      }

      if (!detail) {
        if (attempts >= MAX_RETRY) {
          console.error(`[SYNC RESAS] Abandon ${id} après ${MAX_RETRY} tentatives 429`);
        }
        rapport.erreurs++;
      }
      details.push({ id, detail, isNew: !dbMap[id] });
    }

    // ── 4. Écriture en transaction ──────────────────────────
    db.run('BEGIN');
    try {
      // Mise à jour des statuts (sans re-fetch)
      for (const id of toStatus) {
        db.run('UPDATE reservations SET status = ? WHERE id = ?', [guestyMap[id].status, id]);
      }

      for (const { id, detail, isNew } of details) {
        const s = guestyMap[id];   // données de base depuis le résumé
        const d = detail;          // données financières depuis le détail (peut être null)

        // Nb nuits : depuis le détail si dispo, sinon résumé, sinon calcul
        const nights = (d?.nightsCount || s.nightsCount)
          || (s.checkIn && s.checkOut
              ? Math.round((new Date(s.checkOut) - new Date(s.checkIn)) / 86400000)
              : null);

        // Frais de paiement : money.payments[0].fees[0].amount (formule VBA)
        const fees = d?.money?.payments?.[0]?.fees?.[0]?.amount ?? null;

        db.run(
          `INSERT INTO reservations
             (id, confirmation_code, listing_id, platform, status,
              check_in, check_out, nights, guest_name, confirmed_at,
              fare_accommodation, fare_cleaning, channel_commission, total_paid, payment_fees)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             confirmation_code  = excluded.confirmation_code,
             listing_id         = excluded.listing_id,
             platform           = excluded.platform,
             status             = excluded.status,
             check_in           = excluded.check_in,
             check_out          = excluded.check_out,
             nights             = excluded.nights,
             guest_name         = excluded.guest_name,
             confirmed_at       = CASE WHEN excluded.confirmed_at IS NOT NULL THEN excluded.confirmed_at ELSE confirmed_at END,
             fare_accommodation = CASE WHEN excluded.fare_accommodation IS NOT NULL THEN excluded.fare_accommodation ELSE fare_accommodation END,
             fare_cleaning      = CASE WHEN excluded.fare_cleaning IS NOT NULL THEN excluded.fare_cleaning ELSE fare_cleaning END,
             channel_commission = CASE WHEN excluded.channel_commission IS NOT NULL THEN excluded.channel_commission ELSE channel_commission END,
             total_paid         = CASE WHEN excluded.total_paid IS NOT NULL THEN excluded.total_paid ELSE total_paid END,
             payment_fees       = CASE WHEN excluded.payment_fees IS NOT NULL THEN excluded.payment_fees ELSE payment_fees END`,
          [
            id,
            s.confirmationCode        || null,
            s.listingId               || null,
            s.integration?.platform   || null,
            (s.status === 'canceled' ? 'cancelled' : s.status) || 'confirmed',
            s.checkIn                 || null,
            s.checkOut                || null,
            nights,
            d?.guest?.fullName        || s.guest?.fullName || null,
            d?.guestStay?.createdAt   || null,
            d?.money?.fareAccommodationAdjusted ?? null,
            d?.money?.fareCleaning              ?? null,
            d?.money?.hostServiceFee            ?? null,
            d?.money?.totalPaid                 ?? null,
            fees,
          ]
        );
        if (isNew) rapport.ajoutes++;
        else       rapport.mis_a_jour++;
      }

      db.run('COMMIT');
    } catch(txErr) {
      db.run('ROLLBACK');
      throw txErr;
    }

    // Recalcul versements et frais conciergerie (dépendent de la commission du listing)
    recalculatePayouts();

    console.log(`[SYNC RESAS] fetched=${rapport.fetched} +${rapport.ajoutes} ~${rapport.mis_a_jour} statuts=${rapport.statuts} ⚠${rapport.erreurs}`);
    res.json({ ok: true, rapport });

  } catch(e) {
    console.error('[SYNC RESAS] Erreur :', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API — Recalcul versements (si taux commission listing changé) ─
app.post('/api/reservations/recalculate', (req, res) => {
  try {
    recalculatePayouts();
    res.json({ ok: true, message: 'Versements et frais de conciergerie recalculés.' });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API — Listings (lecture depuis DB) ───────────────────────
app.get('/api/listings', (req, res) => {
  try {
    const ownerId = req.query.owner_id || null;
    let sql = `
      SELECT l.id, l.nom, l.commission, l.cleaning_fee, l.active,
             l.owner_id, o.nom AS owner_nom
      FROM listings l
      LEFT JOIN owners o ON o.id = l.owner_id
    `;
    const params = [];
    if (ownerId) {
      sql += ' WHERE l.owner_id = ?';
      params.push(ownerId);
    }
    sql += ' ORDER BY l.nom COLLATE NOCASE';
    res.json(db.all(sql, params));
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API — Sync Listings depuis Guesty ────────────────────────
app.post('/api/listings/sync', async (req, res) => {
  const force = req.query.force === 'true';
  try {
    console.log(`[SYNC LISTINGS] Démarrage (force=${force})...`);

    // 1. IDs depuis Guesty
    const guestyIds = await guestyApi.getAllListingIds();
    const guestySet = new Set(guestyIds);

    // 2. IDs depuis DB
    const dbListings = db.all('SELECT id FROM listings');
    const dbSet      = new Set(dbListings.map(l => l.id));

    // 3. Catégoriser
    const toFetch      = guestyIds.filter(id => !dbSet.has(id) || force);
    const toDeactivate = [...dbSet].filter(id => !guestySet.has(id));
    const ignores      = guestyIds.filter(id => dbSet.has(id) && !force).length;

    const rapport = { ajoutes: 0, mis_a_jour: 0, inactifs: toDeactivate.length, ignores, erreurs: 0 };

    console.log(`[SYNC LISTINGS] ${guestyIds.length} Guesty / ${dbListings.length} DB / ${toFetch.length} à fetcher`);

    // 4. Récupérer les détails (avant transaction pour ne pas bloquer la DB pendant les appels réseau)
    const details = [];
    for (const id of toFetch) {
      try {
        const l = await guestyApi.getListing(id);
        details.push({ id, listing: l, isNew: !dbSet.has(id) });
        console.log(`[SYNC LISTINGS] OK ${id}`);
      } catch(e) {
        console.error(`[SYNC LISTINGS] Erreur ${id} :`, e.message);
        rapport.erreurs++;
      }
    }

    // 5. Écriture en transaction
    db.run('BEGIN');
    try {
      for (const id of toDeactivate) {
        db.run('UPDATE listings SET active = 0 WHERE id = ?', [id]);
      }

      for (const { id, listing: l, isNew } of details) {
        const nom = l.title || l.nickname || l.name || '—';

        // commissionFormula ex. "net_income*0.10" → taux de base 10 %
        // commissionTaxPercentage ex. 20 → TVA sur la commission (20 %)
        // Taux final facturé au propriétaire = base × (1 + TVA/100)
        let commission = null;
        const rawFormula = l.commissionFormula ?? null;
        if (rawFormula) {
          const m = String(rawFormula).match(/net_income\*([0-9.]+)/i);
          if (m) {
            const base   = parseFloat(m[1]);
            const basePC = base <= 1 ? base * 100 : base;
            const tva    = typeof l.commissionTaxPercentage === 'number' ? l.commissionTaxPercentage : 0;
            commission   = Math.round(basePC * (1 + tva / 100) * 100) / 100;
          }
        }
        console.log(`[SYNC LISTINGS] ${id} formula=${rawFormula} tva=${l.commissionTaxPercentage} → ${commission}%`);

        const cleaningFee = l.financials?.cleaningFee?.value?.formula ?? l.prices?.cleaningFee ?? null;
        const ownerId     = (l.owners && l.owners[0]) || null;
        const active      = l.active ? 1 : 0;

        db.run(
          `INSERT INTO listings (id, nom, commission, cleaning_fee, owner_id, active)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             nom=excluded.nom,
             commission=excluded.commission,
             cleaning_fee=excluded.cleaning_fee,
             owner_id=excluded.owner_id,
             active=excluded.active`,
          [id, nom, commission, cleaningFee, ownerId, active]
        );

        if (isNew) rapport.ajoutes++;
        else        rapport.mis_a_jour++;
      }

      db.run('COMMIT');
    } catch(txErr) {
      db.run('ROLLBACK');
      throw txErr;
    }

    console.log(`[SYNC LISTINGS] +${rapport.ajoutes} ~${rapport.mis_a_jour} ⊘${rapport.inactifs} ⚠${rapport.erreurs}`);
    res.json({ ok: true, rapport });

  } catch(e) {
    console.error('[SYNC LISTINGS] Erreur :', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
      SELECT o.id, o.nom,
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

// ── API — Sync Owners + Listings depuis Guesty ───────────────
app.post('/api/owners/sync', async (req, res) => {
  try {
    console.log('[SYNC] Démarrage synchronisation...');

    const guestyOwners = await guestyApi.getAllOwners();

    // Construire map des owners Guesty
    const guestyMap = {};
    for (const o of guestyOwners) {
      const id  = o._id || o.id;
      const nom = [o.firstName, o.lastName].filter(Boolean).join(' ')
                  || o.fullName || o.name || '—';
      guestyMap[id] = { id, nom };
    }

    // Owners actuellement en DB
    const dbOwners = db.all('SELECT id, nom FROM owners');
    const dbMap    = {};
    for (const o of dbOwners) dbMap[o.id] = o;

    const rapport = { ajoutes: [], supprimes: [], modifies: 0 };

    db.run('BEGIN');
    try {
      // Upsert owners
      for (const [id, o] of Object.entries(guestyMap)) {
        db.run(
          'INSERT INTO owners (id, nom) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET nom=excluded.nom',
          [o.id, o.nom]
        );
        if (!dbMap[id]) rapport.ajoutes.push(o.nom);
        else            rapport.modifies++;
      }

      // Supprimer les owners absents de Guesty
      for (const id of Object.keys(dbMap)) {
        if (!guestyMap[id]) {
          rapport.supprimes.push(dbMap[id].nom);
          db.run('DELETE FROM owners WHERE id = ?', [id]);
        }
      }

      db.run('COMMIT');
    } catch(txErr) {
      db.run('ROLLBACK');
      throw txErr;
    }

    console.log(`[SYNC] +${rapport.ajoutes.length} -${rapport.supprimes.length} ~${rapport.modifies}`);
    res.json({ ok: true, rapport });

  } catch(e) {
    console.error('[SYNC] Erreur :', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── DEBUG ──────────────────────────────────────────────────────
app.get('/api/debug/listing/:id', async (req, res) => {
  try { res.json(await guestyApi.getListing(req.params.id)); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/reservation/:id', async (req, res) => {
  try { res.json(await guestyApi.getReservation(req.params.id)); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Démarrage ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✔  Suivi Réservations v0.1.5 — http://localhost:${PORT}`);
  console.log(`   Réseau local         — http://Black6:${PORT}`);
});
