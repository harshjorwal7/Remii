# Eventum — what time zone does the deployment run in?

**Brief date:** 2026-09-26 · **Method:** read-only (HTTP GET/HEAD only; nothing written, no accounts touched)

## Finding (first)

**No source I can reach states the deployment's time zone.** There is no reachable Eventum *issue-tracking*
deployment in this workspace at all. The only Eventum that exists anywhere I can reach is
**`www.theeventum.com` + `theeventum.onrender.com`, a campus event-registration hub** (`<title>`: "Eventum |
Your Campus Event Hub") — not the issue tracker the request describes. For that product I can say exactly how
it handles time, and it is **not** a configured deployment zone: published event times are stored as
**offset-less wall-clock strings** and rendered in **the viewer's own browser zone**. So the honest answer is
a gap, not a zone name — I am not substituting a default (no "IST", no "UTC" by assumption).

## Evidence — one line per source, named

| Source read (2026-09-26) | What it says about time zone |
|---|---|
| `GET https://theeventum.onrender.com/api/events` → 200, 63,522 bytes, 12 events | Event times are **offset-less wall-clock strings**: `startDate: "2026-09-14T13:30"`, `endDate: "2026-09-14T17:00"` (also `"2026-09-26T18:00"`). **30** such timestamps in the payload carry no `Z`, no offset, no zone name, no TZID. A token grep of the whole payload for `timeZone`/`timezone`/`tz`/`tzid`/`utcOffset`, `Asia/…`, `UTC±nn`, `GMT±nn`, `+05:30`, `getTimezoneOffset`, `en-IN` returned **zero** hits. |
| Same payload — `createdAt` fields | UTC ISO-8601 with `Z` (e.g. `"2026-09-12T17:00:39.592Z"`). That is the database/serialiser layer, **not** a configured application zone. |
| `GET https://theeventum.onrender.com/api/clubs` → 200, 80,925 bytes | No time field of any kind; zero zone tokens. |
| `https://www.theeventum.com/assets/index-CyLJfmkA.js` → 200, 1,481,548 bytes (current public bundle) | **Zero** hits for `timeZone`, `timezone`, `tzid`, `Asia/…`, `getTimezoneOffset`, `en-IN`, `Intl.DateTimeFormat`. Dates are rendered with bare `new Date(x).toLocaleDateString()` / `toLocaleTimeString([])` — i.e. **the visitor's own locale/zone**; no `timeZone` option is ever passed. |
| API discovery routes `/api/config`, `/api/settings`, `/api/timezone`, `/api/time`, `/api/health`, `/api/status`, `/api/info`, `/api/events/ics` | **All 404.** There is no reachable instance-settings or admin-config surface to read a zone from, and no ICS export to read a `TZID` from. |
| `GET https://www.theeventum.com/` **response headers** (200, 1,445-byte SPA shell) | `server: Vercel`, `x-vercel-cache: HIT`, `date: … GMT`. No zone setting. |
| `GET https://theeventum.onrender.com/api/events` **response headers** | `server: cloudflare`, `cf-ray: …-SEA`, `x-render-origin-server: Render`, `date: … GMT`. Edge/PoP identifiers, **not** settings; `Date` is GMT because HTTP mandates it. |
| `https://www.theeventum.com/` HTML shell + `robots.txt`/`sitemap.xml` (per saved audit `eventum-security-audit.md`) | Static SPA shell only; no config file served (`/config.js`, `/config.json`, `/env.js`, `/runtime-config.js` → non-200). No zone anywhere. |
| Earlier brief in this workspace: `eventum-timezone-finding.md` (a file I saved on 2026-09-26, same checks) | Reached the same conclusion; I re-ran the key reads above today and they match. |
| Saved audits in this workspace: `eventum-security-audit.md`, `eventum-security-assessment-2026-09-25.md`, `eventum-security-findings-2026-09-25.md`, `eventum-audit-round2-hack-attempts.md` | All target `www.theeventum.com`; **none mentions a time zone**. They describe an event hub for JECRC University students and clubs (Google OAuth, events/clubs/registrations, Razorpay) — not an issue tracker. |

**Layer statement.** The only time numbers I could read come from (a) the **front end / browser layer** — renders
in the visitor's own zone, per the bundle — and (b) the **data layer** — offset-less stored wall-clock strings
plus UTC `createdAt`. Neither is an application-wide default zone. **The server OS zone and the application
default zone are not exposed on any surface I can reach.**

## What I looked for and did not find

- **The Eventum issue tracker: not identified.** Nothing here lists a deployment URL — workspace memory
  contains only the note that no issue-tracking deployment is reachable and the only Eventum is the campus hub.
- **No internal docs/wiki access.** No connector to Notion/Confluence/Drive/wiki is granted to me, so a page
  documenting the deployment is unreadable from here.
- **No shell/OS access to any Eventum server.** No host folders are granted to this Bot, so I cannot read
  `/etc/localtime`, `php.ini`, an app config file, or a database default.
- **No admin UI reached.** Every settings/config/time route probed returns 404, and admin routes return 401
  anonymously (per the saved audits above).
- **Not looked for:** nothing outside the addresses named above. No open-web hunting for a citation.

## Open questions

1. **Which Eventum is meant** — the open-source Eventum issue tracker, or the campus event hub at
   `theeventum.com` that is the only Eventum present here?
2. **If it is the event hub:** whose zone is authoritative for a published start time — the organiser's device,
   the viewer's device, or the server? Today the data and the front end both point to "the viewer's device",
   with server OS and application default zones unexposed.
3. **Is there an internal wiki or doc page that documents the deployment at all?** Nothing I can reach
   references one; that connector, the instance URL, or host access would close this in one read.
