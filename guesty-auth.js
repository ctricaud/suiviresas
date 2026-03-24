// guesty-auth.js — Gestion du token OAuth2 Guesty
// Persistance en base SQLite (table config)
// Renouvellement uniquement si expiré — max 5/jour chez Guesty

require('dotenv').config();
const https = require('https');
const db    = require('./sql1');

const GUESTY_CLIENT_ID     = process.env.GUESTY_CLIENT_ID;
const GUESTY_CLIENT_SECRET = process.env.GUESTY_CLIENT_SECRET;
const MARGIN               = 5 * 60 * 1000; // 5 min de marge

if (!GUESTY_CLIENT_ID || !GUESTY_CLIENT_SECRET) {
  console.error('[Guesty] ERREUR : GUESTY_CLIENT_ID et GUESTY_CLIENT_SECRET doivent être définis dans .env');
  process.exit(1);
}

// ── Table config ──────────────────────────────────────────────
// Crée la table si elle n'existe pas encore
db.run(`
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

function cfgGet(key) {
  // node-sqlite3-wasm : db.get(sql, params) retourne la ligne ou undefined
  const row = db.get('SELECT value FROM config WHERE key = ?', [key]);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.run(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

// ── Token ─────────────────────────────────────────────────────

/**
 * Retourne un token valide.
 * Lit la base SQLite en premier, renouvelle si absent/expiré.
 */
async function getToken() {
  const token     = cfgGet('guesty_token');
  const expiresAt = parseInt(cfgGet('guesty_expires_at') || '0', 10);
  const now       = Date.now();

  if (token && expiresAt > 0 && now < expiresAt - MARGIN) {
    const restant = Math.round((expiresAt - now) / 60000);
    console.log(`[Guesty] Token en base — valide encore ${restant} min`);
    return token;
  }

  console.log('[Guesty] Renouvellement du token...');
  const data       = await fetchNewToken();
  const newExpires = now + (data.expires_in || 86400) * 1000;

  cfgSet('guesty_token',      data.access_token);
  cfgSet('guesty_expires_at', newExpires);

  console.log(`[Guesty] Token enregistré en base — expire le ${new Date(newExpires).toLocaleString('fr-FR')}`);
  return data.access_token;
}

/**
 * POST vers Guesty pour obtenir un nouveau token
 */
function fetchNewToken() {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type:    'client_credentials',
      scope:         'open-api',
      client_id:     GUESTY_CLIENT_ID,
      client_secret: GUESTY_CLIENT_SECRET,
    }).toString();

    const options = {
      hostname: 'open-api.guesty.com',
      path:     '/oauth2/token',
      method:   'POST',
      timeout:  15000,
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode !== 200) {
            reject(new Error(`Guesty HTTP ${res.statusCode} : ${raw}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('Réponse non-JSON : ' + raw));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout renouvellement token Guesty'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Efface le token en base — force renouvellement au prochain appel
 */
function invalidateToken() {
  cfgSet('guesty_token',      '');
  cfgSet('guesty_expires_at', '0');
  console.log('[Guesty] Token invalidé en base');
}

/**
 * Statut du token (sans appel réseau)
 */
function tokenStatus() {
  const token     = cfgGet('guesty_token');
  const expiresAt = parseInt(cfgGet('guesty_expires_at') || '0', 10);

  if (!token || expiresAt === 0) {
    return { valid: false, message: 'Aucun token en base' };
  }

  const remaining = Math.round((expiresAt - Date.now()) / 60000);
  return {
    valid:            remaining > 0,
    expiresAt:        new Date(expiresAt).toISOString(),
    expiresAtLocal:   new Date(expiresAt).toLocaleString('fr-FR'),
    remainingMinutes: remaining,
  };
}

module.exports = { getToken, invalidateToken, tokenStatus };
