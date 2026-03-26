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

# Sync listings (force = refresh all)
curl -X POST "http://localhost:3010/api/listings/sync?force=true"

# Recalculate all owner payouts and PM revenue
curl -X POST http://localhost:3010/api/reservations/recalculate
```

No build step required. No test suite currently exists.

## Architecture

This is a French-language web app for tracking rental reservations, integrating with the **Guesty** property management platform via OAuth2.

### Stack
- **Backend:** Node.js + Express (port 3010), no TypeScript
- **Database:** SQLite via `node-sqlite3-wasm` (pure JS/WASM, no native compilation needed)
- **Frontend:** Vanilla HTML/CSS/JS served as static files from `public/`
- **HTTP client:** Native `fetch` (Node 18+/undici) — do NOT use the `https` module, it has an OpenSSL GCM bug on Windows/Node 17+ that breaks streaming responses

### Key Files
| File | Role |
|---|---|
| `server.js` | Express server, all route definitions, DB migrations, payout calculations |
| `sql1.js` | SQLite database singleton instance |
| `guesty-auth.js` | OAuth2 token management (client credentials flow, cached in DB) |
| `guesty-api.js` | Guesty API client using `fetch` with pagination support |
| `reservations.db` | SQLite database file |

### Database Schema
- **`owners`** — `id TEXT PK, nom TEXT`
- **`listings`** — `id TEXT PK, nom TEXT, commission REAL, cleaning_fee TEXT, owner_id TEXT FK, active INT`
- **`reservations`** — `id TEXT PK, confirmation_code TEXT, listing_id TEXT FK, platform TEXT, status TEXT, check_in TEXT, check_out TEXT, nights INT, guest_name TEXT, confirmed_at TEXT, fare_accommodation REAL, fare_cleaning REAL, channel_commission REAL, total_paid REAL, payment_fees REAL, owner_payout REAL, pm_revenue REAL`
- **`config`** — `key TEXT PK, value TEXT` (stores Guesty OAuth token and expiration)

WAL mode and foreign keys are enabled via PRAGMA.

### Commission Calculation
Commissions are extracted from Guesty listing data at sync time:
- `commissionFormula` (e.g. `"net_income*0.10"`) → base rate = 10%
- `commissionTaxPercentage` (e.g. `20`) → VAT on commission = 20%
- **Stored commission** = `base × (1 + VAT/100)` → e.g. `10% × 1.20 = 12%`

Payout formulas (aligned with original VBA module):
- `owner_payout = (fare_accommodation − channel_commission − payment_fees) × (1 − commission%)`
- `pm_revenue   = fare_cleaning + commission% × (fare_accommodation − channel_commission − payment_fees)`

`recalculatePayouts()` runs automatically after every reservation sync, and can be triggered manually via `POST /api/reservations/recalculate`.

### Guesty Auth Flow
`guesty-auth.js` manages a single OAuth2 access token stored in the `config` table. It auto-refreshes with a 5-minute safety margin before expiration. Guesty rate-limits token creation to ~5/day — never call the token endpoint unnecessarily.

### Credentials
Credentials are loaded from environment variables via `dotenv`. A `.env` file is required at the project root:
```
GUESTY_CLIENT_ID=...
GUESTY_CLIENT_SECRET=...
```
See `.env.example` for the template.

### API Endpoints

**Owners:**
- `GET /api/owners` — list with aggregated listing counts
- `POST /api/owners/sync` — sync from Guesty

**Listings:**
- `GET /api/listings` — list with commission, owner info
- `POST /api/listings/sync` — sync from Guesty (`?force=true` to refresh existing)

**Reservations:**
- `GET /api/reservations` — list with financials, supports `?listing_id=`, `?owner_id=`, `?status=`
- `POST /api/reservations/sync` — sync upcoming (`?full=true` for full history, `?force=true` to refetch financials)
- `POST /api/reservations/recalculate` — recalculate `owner_payout` and `pm_revenue` for all reservations

**Guesty token:**
- `GET /api/guesty/status` — cached token status (no network call)
- `GET /api/guesty/token` — get/refresh token
- `POST /api/guesty/refresh` — force invalidate and refresh

**Debug:**
- `GET /api/debug/listing/:id` — raw Guesty listing JSON
- `GET /api/debug/reservation/:id` — raw Guesty reservation JSON

### Frontend Pages
- `index.html` — dashboard with navigation buttons
- `owners.html` — owner list with live search and sorting
- `maj-owners.html` — triggers owner sync from Guesty
- `listings.html` — listing list with commission, status, filters
- `maj-listings.html` — triggers listing sync from Guesty
- `reservations.html` — reservation list with financials, month filter widget, filters by listing/owner/status
- `maj-reservations.html` — triggers reservation sync (upcoming or full history)
