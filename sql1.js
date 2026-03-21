// sql1.js — instance SQLite partagée dans tout le projet
// Utilise node-sqlite3-wasm : 100% JavaScript, aucune compilation native
// API identique à better-sqlite3 (synchrone, pas de callbacks)

const { Database } = require('node-sqlite3-wasm');
const path = require('path');

const DB_PATH = path.join(__dirname, 'reservations.db');

const db = new Database(DB_PATH);

db.run('PRAGMA foreign_keys = ON');
db.run('PRAGMA journal_mode = WAL');

module.exports = db;
