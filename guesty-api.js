// guesty-api.js — Requêtes vers l'API Guesty Open API v1
// Base URL : https://open-api.guesty.com/v1
//
// Contexte Windows / Node 25 / OpenSSL 3 :
//   - module https natif → bug GCM (ossl_gcm_stream_update) sur les grosses réponses
//   - fetch/undici       → UND_ERR_SOCKET sur /reservations
// Solution : https natif avec ciphersuites:ChaCha20-Poly1305 (pas de GCM → pas de bug)

const https        = require('https');
const { getToken } = require('./guesty-auth');

const BASE_HOST  = 'open-api.guesty.com';
const BASE_PATH  = '/v1';
const TIMEOUT_MS = 15000;
const MAX_PAGES  = 100;

/**
 * Requête GET générique vers l'API Guesty
 */
async function guestyGet(path, params = {}) {
  const token = await getToken().catch(e => {
    throw new Error('Token Guesty indisponible : ' + e.message);
  });

  const qs       = new URLSearchParams(params).toString();
  const fullPath = BASE_PATH + path + (qs ? '?' + qs : '');

  return new Promise((resolve, reject) => {
    const options = {
      hostname:     BASE_HOST,
      path:         fullPath,
      method:       'GET',
      timeout:      TIMEOUT_MS,
      // ChaCha20-Poly1305 : contourne le bug OpenSSL 3 AES-GCM sur Windows/Node 25
      // (ossl_gcm_stream_update échoue en lecture chunked ; ChaCha20 n'est pas affecté)
      ciphersuites: 'TLS_CHACHA20_POLY1305_SHA256',
      ciphers:      'ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES256-SHA384:ECDHE-RSA-AES128-SHA256',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) {
            reject(new Error(`Guesty API ${res.statusCode} sur ${path} : ${raw.slice(0, 200)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('Réponse non-JSON : ' + raw.slice(0, 200)));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout requête Guesty (${path})`));
    });
    req.on('error', (e) => {
      const detail = e.code ? ` [${e.code}]` : '';
      reject(new Error(e.message + detail));
    });
    req.end();
  });
}

/**
 * Extrait les réservations d'une réponse Guesty.
 * Formats possibles :
 *   - { results: [...], count: N }  (avec fields)
 *   - { "0": {...}, "1": {...}, count: N }  (sans fields)
 *   - tableau direct
 */
function extractResults(data) {
  if (Array.isArray(data))         return data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.data))    return data.data;
  return Object.keys(data)
    .filter(k => /^\d+$/.test(k))
    .map(k => data[k])
    .filter(v => v && typeof v === 'object' && (v._id || v.id));
}

/**
 * Pagination générique sur /reservations avec des params arbitraires.
 */
async function paginateReservations(baseParams) {
  const limit = 100;
  let skip = 0, all = [], page = 0;

  while (page < MAX_PAGES) {
    page++;
    const data    = await guestyGet('/reservations', { ...baseParams, limit, skip });
    const results = extractResults(data);
    const total   = typeof data.count === 'number' ? data.count : Infinity;

    if (!results.length) break;
    all = all.concat(results);
    if (all.length >= total || results.length < limit) break;
    skip = all.length;
  }
  return all;
}

// ── Fonctions exportées ────────────────────────────────────────

/**
 * Tous les owners Guesty.
 */
async function getAllOwners() {
  const data = await guestyGet('/owners');
  return Array.isArray(data) ? data : (data.results || data.data || []);
}

/**
 * Tous les _id de listings Guesty (pagination).
 */
async function getAllListingIds() {
  const limit = 100;
  let skip = 0, ids = [], page = 0;

  while (page < MAX_PAGES) {
    page++;
    const data    = await guestyGet('/listings', { limit, skip, fields: '_id' });
    const results = Array.isArray(data) ? data : (data.results || data.data || []);
    if (!results.length) break;
    for (const l of results) {
      const id = l._id || l.id;
      if (id) ids.push(id);
    }
    if (results.length < limit) break;
    skip += results.length;
  }
  return ids;
}

/**
 * Détail complet d'un listing.
 */
async function getListing(id) {
  return guestyGet(`/listings/${encodeURIComponent(id)}`);
}

/**
 * Réservations à venir (checkIn >= aujourd'hui) — appel unique, rapide.
 * Aucun filtre statut : on stocke le statut tel quel depuis Guesty.
 */
async function getUpcomingReservations() {
  const today   = new Date().toISOString().slice(0, 10);
  const filters = JSON.stringify([{ operator: '$gte', field: 'checkIn', value: today }]);
  return paginateReservations({
    sort:    'checkIn',
    filters,
    fields:  '_id status listingId checkIn checkOut integration confirmationCode guest nightsCount createdAt',
  });
}

/**
 * Toutes les réservations d'un listing donné (pagination).
 * Utilisé pour l'historique complet : appelé pour chaque listing de la DB.
 * C'est la seule façon fiable de contourner la fenêtre temporelle Guesty.
 */
async function getReservationsByListing(listingId) {
  const filters = JSON.stringify([{ operator: '$eq', field: 'listingId', value: listingId }]);
  const results = await paginateReservations({
    sort:    '-checkIn',
    filters,
    fields:  '_id status listingId checkIn checkOut integration confirmationCode guest nightsCount createdAt',
  });
  if (results.length) {
    console.log(`[RESAS] listing ${listingId} → ${results.length} réservations`);
  }
  return results;
}

/**
 * Détail financier d'une réservation.
 * Fields identiques au module VBA GuestyGetReservation (ni plus, ni moins).
 * On ne demande PAS status/listingId/platform — ils viennent du résumé.
 */
async function getReservation(id) {
  const fields = [
    'money.hostPayout',
    'createdAt',
    'guestStay.createdAt',
    'guest.fullName',
    'money.payments.fees.amount',
    'money.fareAccommodationAdjusted',
    'nightsCount',
    'checkIn',
    'checkOut',
    'money.fareCleaning',
    'money.hostServiceFee',
    'money.totalTaxes',
    'money.totalPaid',
  ].join(' ');
  return guestyGet(`/reservations/${encodeURIComponent(id)}`, { fields });
}

module.exports = {
  guestyGet,
  getAllOwners,
  getAllListingIds,
  getListing,
  getUpcomingReservations,
  getReservationsByListing,
  getReservation,
};
