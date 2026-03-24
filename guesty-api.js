// guesty-api.js — Requêtes vers l'API Guesty Open API v1
// Base URL : https://open-api.guesty.com/v1
// Utilise fetch (undici, natif Node 18+) pour éviter le bug OpenSSL GCM sur Windows/Node 17+

const { getToken } = require('./guesty-auth');

const BASE_URL   = 'https://open-api.guesty.com/v1';
const TIMEOUT_MS = 15000;
const MAX_PAGES  = 100;

/**
 * Requête GET générique vers l'API Guesty
 */
async function guestyGet(path, params = {}) {
  const token = await getToken().catch(e => {
    throw new Error('Token Guesty indisponible : ' + e.message);
  });

  const qs  = new URLSearchParams(params).toString();
  const url = BASE_URL + path + (qs ? '?' + qs : '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    });

    const text = await res.text();
    let json;
    try   { json = JSON.parse(text); }
    catch { throw new Error('Réponse non-JSON : ' + text.slice(0, 200)); }

    if (!res.ok) throw new Error(`Guesty API ${res.status} sur ${path} : ${text.slice(0, 200)}`);
    return json;

  } catch(e) {
    if (e.name === 'AbortError') throw new Error(`Timeout requête Guesty (${path})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
    fields:  '_id status listingId checkIn checkOut integration confirmationCode guest nightsCount',
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
    fields:  '_id status listingId checkIn checkOut integration confirmationCode guest nightsCount',
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
