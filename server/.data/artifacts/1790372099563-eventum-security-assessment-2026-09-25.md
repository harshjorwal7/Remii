# Security Assessment — theeventum.com

**Target (authorized):** `theeventum.com` and its direct subdomains. Owner is a cofounder; testing is permitted.
**Method:** passive / non-destructive only. No payloads, no data modification, no brute force, no DoS.
**Date of testing:** 25 September 2026 (all observations below are from that session).
**Scope boundary:** the site is hosted on Vercel. Vercel's edge, GoDaddy's DNS servers and every other third-party host were **not** probed — anything that belongs to them is flagged, not tested.

## What the target actually is

| Item | Observed value | Source |
|---|---|---|
| Apex `theeventum.com` | `A 76.76.21.21`, responds **308 Permanent Redirect → https://www.theeventum.com/** | DNS (Google DoH), SSL Labs endpoint data |
| `www.theeventum.com` | `CNAME cname.vercel-dns.com` → `76.76.21.93`, `66.33.60.194` | DNS (Google DoH) |
| Hosting | `Server: Vercel` on every response; `X-Vercel-Cache: HIT` | SSL Labs HTTP transaction |
| Nameservers | `ns73/ns74.domaincontrol.com` (GoDaddy) | DNS |
| Site type | Static SPA shell, HTML document only 1,445 bytes, hash routes (`#home`, `#clubs`, `#gallery`) | Content-Length, sitemap.xml |
| Certificates | Let's Encrypt; apex valid 2026-09-08 → 2026-12-07; www valid 2026-09-07 → 2026-12-06; SANs limited to the two names; not revoked | Cert Spotter CT log API |

---

## HIGH

### H1. No SPF, no DMARC, no DKIM — the domain can be spoofed in email

**What was observed.** The domain publishes no email-authentication records at all.

**Evidence (DNS TXT lookups via Google DNS-over-HTTPS):**
- `theeventum.com TXT` → returns **only** `google-site-verification=qAqmBUHxuLHyjI4VOUvh8tVC1AgoHWTjlYXwEC4Ei6c`. There is **no `v=spf1` record**.
- `_dmarc.theeventum.com TXT` → **Status 3 (NXDOMAIN)** — no DMARC record, not even `p=none`.
- `google._domainkey.theeventum.com`, `default._domainkey.theeventum.com`, `selector1._domainkey.theeventum.com` → all **NXDOMAIN** — no DKIM selector published.
- `theeventum.com MX` → no records (the domain does not receive mail).

**Why it matters.** With no SPF and no DMARC, anyone can send mail that appears to come from `@theeventum.com`. Your audience is students who will plausibly pay for event tickets and hand over passwords. A spoofed "Eventum ticket payment failed — re-enter your card" mail from your own domain lands in inboxes with nothing marking it as forged, and your brand absorbs the damage. DMARC also gives you the only reporting channel you'd need to detect an existing spoofing campaign.

**Fix.**
1. Add SPF for the service you actually send from, e.g. `v=spf1 include:<provider> -all` (use `~all` while you tune, then tighten to `-all`). Do not publish a bare `v=spf1 +all` or `?all`.
2. Publish DKIM with whatever sends your transactional mail (Resend, SendGrid, Postmark, Google Workspace…) and confirm the selector resolves.
3. Publish DMARC: `_dmarc.theeventum.com TXT "v=DMARC1; p=none; rua=mailto:dmarc@theeventum.com; fo=1"` first — collect a few weeks of reports — then move to `p=quarantine` and finally `p=reject`.
4. While you're in DNS: you have **no MX record**, so `support@theeventum.com` (and any reply-to you put in event mail) bounces today. If that's intentional, ignore; if not, it's a functional gap worth closing.

---

## MEDIUM

### M1. No Content-Security-Policy

**Observed.** The full response header set for `GET https://www.theeventum.com/` (HTTP/1.1 **200 OK**, captured by SSL Labs' own request) is:

```
Accept-Ranges: bytes
Access-Control-Allow-Origin: *
Age: 418079
Cache-Control: public, max-age=0, must-revalidate
Content-Disposition: inline
Content-Length: 1445
Content-Type: text/html; charset=utf-8
Date: Fri, 25 Sep 2026 12:05:25 GMT
Etag: "e3d1052fabf4e8b6dfe643709ad1d59e"
Last-Modified: Sun, 20 Sep 2026 15:57:26 GMT
Server: Vercel
Strict-Transport-Security: max-age=63072000
X-Vercel-Cache: HIT
X-Vercel-Id: sfo1::5c9w9-1790337925969-d2a18bd3ccf9
```

There is **no `Content-Security-Policy`** header on this response (nor on the apex 308 response).

**Why it matters.** CSP is the last line of defence if injected script ever reaches a user — from a third-party script tag, a compromised dependency, or a future user-generated content feature (event listings, club pages). Without it, a single injected script can read everything the page can and call any endpoint the page can.

**Fix.** Ship it in report-only first: `Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; report-uri <collector>`. Watch the violation reports, allowlist what's genuinely needed (your analytics/CDN/font origins), then switch to enforcing.

### M2. Clickjacking exposure — no `X-Frame-Options` and no `frame-ancestors`

**Observed.** `X-Frame-Options` is **absent** from the same 200 response header set above, and there is no CSP (see M1) to supply `frame-ancestors`. The page returned a normal **200** with no framing controls.

**Why it matters.** Any site can put Eventum in an invisible iframe and overlay fake UI — a classic way to trick students into clicking "Register" or authorising something. Nothing in the response stops it.

**Fix.** `X-Frame-Options: DENY` (or `SAMEORIGIN`), **and** `Content-Security-Policy: frame-ancestors 'none'`. Add both; older browsers only read the first, modern ones only the second.

### M3. `Access-Control-Allow-Origin: *` on the document response

**Observed.** `Access-Control-Allow-Origin: *` is present on the `GET https://www.theeventum.com/` 200 response (header list above). No `Access-Control-Allow-Credentials` was present.

**Why it matters.** A wildcard CORS policy lets any website read these responses cross-origin. On the plain public marketing HTML it is low impact. It becomes serious the moment the same wildcard is applied to anything authenticated or user-specific. I could only observe the HTML document — I had no way to send an `Origin` header at an API, so **I cannot tell you whether the same wildcard covers user data.** Treat that as an open question to answer from your own config, not a conclusion from me.

**Fix.** Remove the wildcard origin from routes that serve anything user-specific; allowlist exact origins (`https://www.theeventum.com`) instead. Never pair `*` with credentials. In Vercel, this is usually a `vercel.json` `headers` rule or a middleware default — check why a wildcard is being emitted on the HTML route at all.

---

## LOW

### L1. `X-Content-Type-Options: nosniff` missing
Not present on the 200 response. Browsers may MIME-sniff a response into a more dangerous type than intended. **Fix:** add `X-Content-Type-Options: nosniff` to all responses.

### L2. `Referrer-Policy` missing
Not present. Full URLs (including any future query-string tokens) can leak in `Referer` to third parties. **Fix:** `Referrer-Policy: strict-origin-when-cross-origin`.

### L3. `Permissions-Policy` missing
Not present. Browser features (camera, microphone, geolocation, payment) are unrestricted for the page and any framed content. **Fix:** `Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()` — add back only what you use.

### L4. HSTS is on, but incomplete
**Observed** (SSL Labs): `Strict-Transport-Security: max-age=63072000` on both apex and www, status *present*. The header carries **no `includeSubDomains`** and **no `preload`**, and the preload lists report `theeventum.com` / `www.theeventum.com` as **absent** in Chrome, Edge, Firefox and IE.
**Why it matters.** Two years of max-age is good, but subdomains aren't covered, and without preload a first-visit downgrade (a user typing the plain-HTTP URL or a hijacked first request) is still possible.
**Fix:** `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` — then submit at hstspreload.org. Only add `preload` when you're certain every subdomain will always be HTTPS (today they resolve to nothing, so that's easy).

### L5. No CAA record — any certificate authority may issue for the domain
**Observed.** `theeventum.com CAA` → no answer (no record). Your current certs are Let's Encrypt (valid, non-revoked, correct SANs), but nothing in DNS restricts issuance.
**Fix:** `theeventum.com CAA 0 issue "letsencrypt.org"` plus any other CA you legitimately use, and `0 iodef "mailto:security@theeventum.com"`. If you also use a Vercel-managed/other CA, include it or you will break renewals.

### L6. DNSSEC is not enabled
**Observed.** `theeventum.com DS` → no answer at the `.com` registry (NSEC/NXDOMAIN), i.e. the zone is unsigned and the chain of trust stops at the registrar.
**Fix:** enable DNSSEC at GoDaddy (the zone's nameservers are `ns73/ns74.domaincontrol.com`) and publish the DS record. Watch it for a week after enabling — a misconfigured rollover makes the domain unresolvable.

### L7. Two hygiene items around DNS records and disclosure
- **`www` CNAME points at a third-party host** (`cname.vercel-dns.com`). It resolves and serves content today, so there is **no dangling record right now**. But if the Vercel project or the domain in Vercel is ever deleted while the CNAME stays, `www.theeventum.com` becomes claimable by whoever registers the orphaned target — subdomain takeover. **Fix:** delete the DNS record when you retire the project, and keep the domain "verified" in Vercel so nobody else can attach it.
- **No `/.well-known/security.txt`** (returns non-200) and no published security contact. **Fix:** publish a `security.txt` with a monitored contact so the next person who finds a bug reports it to you instead of posting it.

---

## INFO — verified clean / nothing found

- **TLS configuration is genuinely good.** SSL Labs grades **A+** for both `theeventum.com` and `www.theeventum.com`. Only **TLS 1.2 and 1.3**, forward secrecy, AEAD suites, secure renegotiation, and negative results for Heartbleed, POODLE, FREAK, Logjam, CCS injection, Ticketbleed, Zombie POODLE, GoldenDoodle and 0-RTT. HTTP/2 via ALPN. The only nits: **OCSP stapling is off**, and a second certificate chain is served when the client sends no SNI (the server's generic default, untrusted for this name — normal for a shared Vercel edge, not a finding about you).
- **Certificates are healthy.** Let's Encrypt, both names covered by their own cert, not revoked, trusted under Mozilla/Apple/Android/Java/Windows root stores, ~90-day rotation happening (issued 7–8 Sept, expiring 6–7 Dec 2026).
- **Canonical-host and HTTP→HTTPS handling is correct.** The apex answers over HTTPS with `308 Permanent Redirect` to `https://www.theeventum.com/` **and** an HSTS header on the redirect itself, so the redirect isn't strippable. (I could not capture the raw 30x headers for plain-HTTP requests — my fetcher follows redirects and reports the final page — so I'm not claiming more than the 308 I actually saw. Unverified.)
- **No exposed source, config or backup files.** All of these returned non-200 (nothing served): `/.git/HEAD`, `/.git/config`, `/.gitignore`, `/.env`, `/.env.production`, `/.env.local`, `/package.json`, `/vercel.json`, `/next.config.js`, `/config.json`, `/backup.zip`, `/.DS_Store`, `/server-status`, `/wp-config.php`, `/assets/`, `/admin`, `/api/`, `/api/users`. No WordPress/CMS fingerprints were found anywhere (no `wp-config.php`, no `/server-status`), so there is no CMS to patch here — the app is a static front end.
- **`robots.txt` is absent (404)** — so it leaks nothing. **`sitemap.xml` exists** and contains only the public homepage and hash anchors (`#home`, `#clubs`, `#gallery`) — no admin, staging or private paths leaked.
- **No subdomains exist to attack.** Every one of ~20 common names (`app`, `api`, `admin`, `staging`, `dev`, `test`, `portal`, `dashboard`, `blog`, `docs`, `status`, `cdn`, `events`, `login`, `auth`, `mail`, `m`, broader set) returned **NXDOMAIN**, and the Certificate Transparency logs contain only `theeventum.com` and `www.theeventum.com`. A search engine pass also surfaced no additional subdomains.
- **No open redirect observed.** `/?redirect=https://example.com` and `/?next=//example.com` both returned the normal page (200, same content) with no server-side redirect. Client-side routing in the SPA could still redirect internally; I saw no evidence of a redirect that leaves the site.
- **No cookies were set** on any response I observed, so there is no cookie-flag (Secure/HttpOnly/SameSite) misconfiguration visible from the outside.

---

## NOT ASSESSED — and why (no invented results)

- **Port scan of the site's host.** `theeventum.com` resolves to `76.76.21.21`, which is **Vercel's shared edge**, not a machine you control — scanning it would be testing a third-party system, which is explicitly out of scope. Separately, this deployment has no host/shell access (`host_list_folders` returned "No host folders are granted to this Bot"), so no port scanner was available. Only **443** (TLS) and **80** (HTTP, which redirects) were exercised, non-invasively.
- **Front-end dependency / framework versions vs known CVEs.** I could not read the raw HTML or JavaScript bundles. My page reader returns extracted text, not source, and every text-fetch proxy I tried (allorigins raw and get, codetabs, corsproxy.io, cors.lol, jsonp.afeld.me, whateverorigin) refused the request. All I could confirm is that the HTML document is a 1,445-byte SPA shell served from Vercel's cache. **No version claims, therefore no CVE claims** — this needs either your repo (`package.json` + `npm audit`) or a browser session.
- **Cookie flags on authenticated sessions** (Secure / HttpOnly / SameSite) — no login flow is reachable on `theeventum.com` or `www` (see next item), and no `Set-Cookie` was observed. Needs a real signed-in session.
- **User enumeration on login/register.** `/login`, `/register`, `/admin` and `/api/...` all return non-200 on this host, so there is nothing here to test — the sign-in flow appears to live off-host (the site's "Get Started"/"Launch" CTA). If that backend is on a hostname you control, point me at it and it's a 10-minute check; if it's a vendor's domain, it's out of scope.
- **CORS with an `Origin` header, and any authenticated API behaviour.** I have no way to send custom request headers from this deployment, so I could only read the one plain `GET /` transaction that SSL Labs performed. The `ACAO: *` finding (M3) is real for the HTML document and *unproven* for APIs.
- **Third-party components deliberately not probed:** Vercel (host/CDN), GoDaddy (DNS/registrar), Google (the site-verification token in your DNS). Also noted and **not tested** because they are unrelated businesses: `eventum.co`, `app.eventum.co` and `theeventu.com` — similar names, different owners; worth knowing they exist for brand-confusion, nothing more.

---

## Fix list, shortest path to green

1. **Today:** SPF + DKIM + DMARC (`p=none` to start) — stop the spoofing (H1).
2. **This week:** one header block on the app (CSP report-only, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`), drop the wildcard CORS on HTML routes (M1–M3, L1–L3). In Vercel this is a single `headers` rule in `vercel.json` or middleware.
3. **This month:** `includeSubDomains; preload` on HSTS, CAA record, DNSSEC at GoDaddy, `security.txt` (L4–L7).
4. **Then:** re-check the two open questions I couldn't close — CORS on your API surface, and dependency versions from your repo (`npm audit` / `pip-audit`, whichever applies).
