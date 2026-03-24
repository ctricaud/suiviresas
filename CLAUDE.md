# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start the server (port 3010)
npm start
# or: node server.js

# Access the app
# http://localhost:3010
```

No build step required. No test suite currently exists.

## Architecture

This is a French-language web app for tracking rental reservations, integrating with the **Guesty** property management platform via OAuth2.

### Stack
- **Backend:** Node.js + Express (port 3010), no TypeScript
- **Database:** SQLite via `node-sqlite3-wasm` (pure JS/WASM, no native compilation needed)
- **Frontend:** Vanilla HTML/CSS/JS served as static files from `public/`

### Key Files
| File | Role |
|---|---|
| `server.js` | Express server, all route definitions |
| `sql1.js` | SQLite database singleton instance |
| `guesty-auth.js` | OAuth2 token management (client credentials flow, cached in DB) |
| `guesty-api.js` | Guesty API client with pagination support |
| `reservations.db` | SQLite database file |

### Database Schema
- **`owners`** — `id TEXT PK, nom TEXT, email TEXT`
- **`listings`** — `id TEXT PK, nom TEXT, owner_id TEXT FK, active INT`
- **`config`** — `key TEXT PK, value TEXT` (used to store the Guesty OAuth token and its expiration)

WAL mode and foreign keys are enabled via PRAGMA.

### Guesty Auth Flow
`guesty-auth.js` manages a single OAuth2 access token stored in the `config` table. It auto-refreshes with a 5-minute safety margin before expiration. Guesty rate-limits token creation to ~5/day, so the caching layer is important — never call the token endpoint unnecessarily.

### API Endpoints
**Data:**
- `GET /api/owners` — owners with aggregated listing counts
- `POST /api/owners/sync` — sync owners from Guesty into local DB (uses a transaction)

**Token management:**
- `GET /api/guesty/status` — cached token status (no network call)
- `GET /api/guesty/token` — get/refresh token
- `POST /api/guesty/refresh` — force invalidate and refresh

### Frontend Pages
- `index.html` — dashboard with navigation buttons
- `owners.html` — owner list with live search and sorting (fetches `/api/owners`)
- `maj-owners.html` — triggers owner sync from Guesty (`POST /api/owners/sync`)
- `placeholder.html` — template for unimplemented pages (reservations, listings, etc.)

### Credentials
Guesty OAuth2 credentials are currently hardcoded in `guesty-auth.js`. There is no `.env` file. If moving credentials to environment variables, update `guesty-auth.js` to read from `process.env`.
