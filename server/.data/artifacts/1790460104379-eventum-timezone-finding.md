# Eventum — time zone of the deployment: what I could and could not establish

**Date of checks:** 2026-09-26 (UTC, per the server `Date:` headers I read)
**Method:** read-only. Only GET/HEAD requests. No settings, config or accounts touched. Nothing written to any deployment.

## Headline

**I could not establish a time zone for an Eventum *issue-tracking* deployment, because no such deployment is
reachable from this workspace and nothing I can read names one.** I am not substituting a default (no "IST",
no "UTC" by assumption).

Separately: the only "Eventum" that exists anywhere I can reach is **`www.theeventum.com` +
`theeventum.onrender.com`, a campus *event-registration* hub** (HTML `<title>`: "Eventum | Your Campus Event
Hub"). It is not an issue tracker. For that product I did find how it handles time — see below — but that is a
different product from the one the brief describes, so it does not answer the question as asked.

## What I actually read, and what each source says about time

| Source read | What it says about time zone |
|---|---|
| `https://www.theeventum.com/` HTML shell (read 2026-09-26) | Nothing. Static SPA shell; no config, no zone, no env file (`/config.js`, `/config.json`, `/env.js`, `/runtime-config.js`, `/assets/config.js` all 404). |
| `/assets/index-CyLJfmkA.js` (current public bundle, 1,481,548 bytes, read 2026-09-26) | No time-zone setting at all: 0 hits for `timeZone`, `timezone`, `Asia/…`, `Kolkata`, `getTimezoneOffset`, `en-IN`. Dates are rendered with bare `new Date(...).toLocaleDateString()` / `toLocaleTimeString([])` — i.e. **the visitor's own browser locale/zone**, not a configured deployment zone. |
| `GET https://theeventum.onrender.com/api/events` (200, 12 events, read 2026-09-26) | Event times are stored as **offset-less wall-clock strings**, e.g. `startDate: "2026-09-14T13:30"`, `endDate: "2026-09-14T17:00"` — no offset, no zone name, no TZID. `createdAt` is UTC ISO-8601 (`"2026-09-12T17:00:39.592Z"`) — that is the database/serialiser layer, not a configured zone. A grep of the whole payload for `Asia/…`, `UTC+nn`, `GMT+nn`, `+05:30`, `timezone`, `tz` returned nothing (the one apparent `IST` hit was the substring inside the word "HE**IST**", a false positive). |
| `GET https://theeventum.onrender.com/api/clubs` (200, read 2026-09-26) | No time field of any kind; the only "India" strings are prose in club descriptions. |
| Config/settings/admin discovery on the API — `/api/config`, `/api/settings`, `/api/status`, `/api/health`, `/api/time`, `/api/version`, `/api/info`, `/api/me`, `/api/timezone`, `/api/preferences` | **All 404** ("Cannot GET …"). There is no reachable instance settings or admin config surface to read a zone from. |
| Response headers, both hosts | `Date: … GMT` on every response (HTTP mandates GMT — this says nothing about the deployment's zone). `server: Vercel` / `x-vercel-id: pdx1::…` on the front end (edge PoP identifier, not a setting); `server: cloudflare`, `cf-ray: …-SEA`, `x-render-origin-server: Render`, `rndr-id: …` on the API (edge/PoP identifiers, not settings). |
| `GET /api/events/*` fallbacks (`/api/events/ics`, `/api/events/export`) | 404 — no calendar/ICS export to read a `TZID` from. |

**Layer statement for the one product I could read:** the surviving numbers come from the **front end / browser
layer** (rendering in the visitor's own zone, per the bundle) and the **data layer** (offset-less stored
strings + UTC `createdAt`). Neither is an application-wide default zone, and the **server OS and application
default zones are not exposed on any surface I could reach.**

## What I tried and could not reach (gaps, stated plainly)

- **The Eventum issue-tracker itself: not identified.** Nothing in the workspace lists one — no memory entry,
  no open task, no note. (Read: `memory_list` → none; `todo_list` → none; `host_list_folders` → "No host
  folders are granted to this Bot"; `get_chat_history` → nothing said earlier.)
- **No internal docs/wiki access.** I hold no connected-app tools in this workspace: `composio_search_tools`
  returned only my own local tools, and the sandbox reports no user API key (`client failed API Key not
  provided`), so no Notion/Confluence/wiki/Drive source is readable from here. A wiki or doc page naming the
  Eventum deployment would need that connector granted to me.
- **No shell/OS access to any Eventum server.** `host_list_folders` → no folders granted; the sandbox is an
  isolated container (a `find / -iname '*eventum*'` returned nothing). So I could not read `/etc/localtime`,
  `php.ini`, an app config file or a database default.
- **No admin UI reached.** The only reachable instance (`theeventum.onrender.com`) answers 404 for every
  settings/config/admin route I probed, and its admin routes return 401 anonymously (per the earlier audits
  saved in this workspace: `eventum-security-audit.md`, `eventum-security-assessment-2026-09-25.md`,
  `eventum-security-findings-2026-09-25.md`, `eventum-audit-round2-hack-attempts.md` — all target
  `www.theeventum.com`, and none of them mentions a time zone either).
- **Product mismatch.** Those same saved audits describe the reachable "Eventum" as an event hub for JECRC
  University students and clubs (Google OAuth, events/clubs/registrations, Razorpay). Nothing in them
  describes an issue-tracking deployment.

## To close this

Give me the Eventum issue-tracker instance URL, or grant me the connector that holds the deployment docs
(Notion/Confluence/Drive/wiki) or host access to the server. With any one of those I can read the zone — from
an admin/config page, the app's config file, `localtime`, or the database default — and say which layer it
belongs to.

## Open questions

1. Which Eventum is meant — the open-source **Eventum issue tracker**, or the campus **Eventum event hub** at
   `theeventum.com` that is the only "Eventum" present in this workspace?
2. If it is the event hub: whose zone is authoritative for a published start time — the organiser's device,
   the viewer's device, or the server? Right now the data and the front end suggest "the viewer's device",
   with server OS and application default zones unexposed.
3. Is there an internal wiki page that documents the deployment at all? Nothing I can read references one.
