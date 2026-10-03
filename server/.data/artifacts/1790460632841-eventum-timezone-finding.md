# Eventum timezone — finding and sources

## Finding
No deployment of "Eventum" that I can reach publishes a time zone: the only live deployment I found (the campus hub theeventum.com, Express API at theeventum.onrender.com) declares no time zone anywhere I can read, and the Eventum issue-tracker software documents only a software *default* of UTC that each install can override — while no issue-tracking instance is reachable at all.

## Evidence (each line names the document or address)

**Campus event hub — theeventum.com**
- `https://www.theeventum.com/` (HTML shell, 1,445 bytes, fetched directly): `<title>Eventum | Your Campus Event Hub</title>`, meta description "Streamlining campus events and registrations…". No timezone, no locale, no date-format setting anywhere in the document head or body.
- `https://www.theeventum.com/assets/index-CyLJfmkA.js` (frontend bundle, 1,481,548 bytes): zero IANA time-zone literals (no `Asia/…`, no `Kolkata`) and zero `timeZone:` options. Dates are rendered with `new Date(x).toLocaleDateString()` / `toLocaleString()` / `toLocaleTimeString()`, i.e. in **the viewer's own browser timezone**, not a fixed deployment zone. Example strings: `new Date(e.createdAt).toLocaleDateString()`, `new Date(e.date).toLocaleDateString()`.
- `https://theeventum.onrender.com/api` → `{"message":"Eventum API is running!"}`. Backend identified: Express (error pages read `Cannot GET /…`), MongoDB documents (`_id`, `__v`).
- `https://theeventum.onrender.com/api/events` (12 records) and `/api/clubs`: no field named `timeZone`, `timezone`, `tz` or `serverTime` exists in either payload (checked by grep on the raw JSON).
- Event records in `/api/events`: `"createdAt":"2026-09-12T17:00:39.592Z"` (UTC ISO), but event times stored as timezone-less wall-clock strings — `"startDate":"2026-09-14T13:30"`, `"endDate":"2026-09-14T17:00"`, `"date":"2026-09-26 • 18:00"`. The app therefore never pins a zone: it stores local wall time and lets the browser format it.
- HTTP response headers, `https://theeventum.onrender.com/api`: `server: cloudflare`, `x-render-origin-server: Render`, `rndr-id: 7d8c7a34-…` → hosted on **Render**. Frontend headers from `https://www.theeventum.com/`: `server: Vercel`, `x-vercel-id: pdx1::…` → static shell served by **Vercel**. Neither carries an application timezone; the HTTP `date:` header is always GMT and says nothing about the runtime zone.
- Endpoints probed for a zone/settings value, all answering **404**: `/api/config`, `/api/settings`, `/api/stats`, `/api/users`, `/api/time`, `/api/tz`, `/api/timezone`, `/api/server-time`, `/api/version`, `/api/info`, `/api/init`, `/api/constants`, `/health`, `/api/health`, `/healthz`. `/api/organizer/events` → `401 {"message":"Unauthorized"}`.

**Eventum issue-tracking software**
- `github.com/eventum/eventum`, file `docs/wiki/Basic-User/FAQ.md`, lines 68–76 (read raw at `raw.githubusercontent.com/eventum/eventum/master/docs/wiki/Basic-User/FAQ.md`):
  "### Problem: Eventum is using UTC as the default time zone — Solution: Log in and click `Preferences` … pick your time zone … To set the default time zone for new users, add this statement to `config/config.php`: `define('APP_DEFAULT_TIMEZONE', 'Europe/Tallinn');`".
  So: the documented **default is UTC**, and the zone is a per-install setting. `Europe/Tallinn` there is an *example value*, not the default.
- `config/config.php.example` in the same repository: grep for `timezone` / `date_default_timezone` returns nothing — the file does not set a zone.

## What I looked for and did not find
- Any published statement of a deployment time zone for theeventum.com — none in the served HTML, the JS bundle, the API payloads, or any probed endpoint.
- Any IANA time-zone literal anywhere in the campus hub's frontend or API data.
- Any **reachable Eventum issue-tracking deployment** (consistent with the brief; I did not go hunting for one).
- Any citable statement that Render or Vercel services run in a given zone: `render.com/docs/environment-variables`, `/docs/docker` and `/docs/deploys` contain no timezone or `TZ` statement, so I cannot source "the deployment runs in UTC" from the platform either.
- Direct reads of `/clubs`, `/gallery`, `/events`, `/about`, `/contact` on theeventum.com return 404 (client-routed SPA, no SPA fallback for those paths on a direct fetch), so there is no secondary page to quote.

## Ambiguity — which "Eventum"?
At least four products share the name:
1. **theeventum.com** — campus event hub (the one the brief says is the only reachable deployment). Vercel frontend + Render API; events are held at **JECRC University, Jaipur** (`venue`/`location` fields in `/api/events`).
2. **eventum/eventum** on GitHub — self-hosted PHP issue tracker; documented default UTC (source above). No instance reachable.
3. **eventum.run** — synthetic event generator (docs read: `eventum.run/docs/core/concepts/scheduling`). Timezone is **user-supplied** there (`--timezone America/New_York`, or `timezone: Europe/Berlin` in `generator.yml`); that page states no default.
4. **eventum.co / app.eventum.co** — event-management SaaS. I did not inspect its runtime.

## Open questions
- Which Eventum is actually meant.
- If it is the campus hub: are its event times meant to be read as **Asia/Kolkata** (IST, UTC+5:30)? The venue is in Jaipur and the stored wall-clock strings are consistent with IST — but **nothing published states it**, so this is inference, not a sourced answer.
- To pin the campus hub down definitively, someone with access to the Render service would need to read the service's `TZ` environment variable or run `date` in the container. I have no such access.

## Actions
Read-only: unauthenticated GETs to public pages and public API endpoints only. No writes, no messages sent, no memory written.
