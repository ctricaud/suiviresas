// guesty-api.js — Requêtes vers l'API Guesty Open API v1
// Base URL : https://open-api.guesty.com/v1

const https        = require('https');
const { getToken } = require('./guesty-auth');

const BASE_HOST = 'open-api.guesty.com';
const BASE_PATH = '/v1';

/**
 * Requête GET générique vers l'API Guesty
 */
function guestyGet(path, params = {}) {
  return new Promise(async (resolve, reject) => {
    let token;
    try { token = await getToken(); }
    catch (e) { return reject(new Error('Token Guesty indisponible : ' + e.message)); }

    const qs = new URLSearchParams(params).toString();
    const fullPath = BASE_PATH + path + (qs ? '?' + qs : '');

    const options = {
      hostname: BASE_HOST,
      path:     fullPath,
      method:   'GET',
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
            reject(new Error(`Guesty API ${res.statusCode} sur ${path} : ${raw}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('Réponse non-JSON : ' + raw));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Récupère TOUS les owners avec pagination automatique
 * Retourne un tableau plat de tous les owners
 */
async function getAllOwners() {
  const limit  = 100;
  let   skip   = 0;
  let   all    = [];
  let   total  = null;

  do {
    const data = await guestyGet('/owners', { limit, skip });

    // L'API Guesty retourne { results: [...], count: N } ou { data: [...] }
    const results = data.results || data.data || [];
    if (total === null) total = data.count ?? data.total ?? results.length;

    all  = all.concat(results);
    skip += results.length;

    if (results.length === 0) break;

  } while (all.length < total);

  return all;
}

/**
 * Récupère TOUS les listings avec pagination automatique
 * Champs limités : id, nickname, ownerId
 */
async function getAllListings() {
  const limit  = 100;
  let   skip   = 0;
  let   all    = [];
  let   total  = null;

  do {
    const data = await guestyGet('/listings', {
      limit,
      skip,
      fields: 'id nickname ownerId active',
    });

    const results = data.results || data.data || [];
    if (total === null) total = data.count ?? data.total ?? results.length;

    all  = all.concat(results);
    skip += results.length;

    if (results.length === 0) break;

  } while (all.length < total);

  return all;
}

module.exports = { guestyGet, getAllOwners, getAllListings };
