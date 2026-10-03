# Passive Security Audit — www.theeventum.com
Date of testing: 2026-09-25 (all times UTC). Method: read-only / non-destructive probes only.
Authorized by the requester. No logins attempted, no brute force, no injection payloads sent, no data written.

## Scope and inventory (observed)
- `www.theeventum.com` → CNAME `cname.vercel-dns.com` (Vercel). Apex `theeventum.com` → 76.76.21.21 (Vercel), 308 redirect to www.
- Front end: Vite + React single-page app; single bundle `/assets/index-DQG0JDwL.js` (1.47 MB), no source maps published.
- Backend API (found in the front-end bundle, same product, host named "theeventum"): `https://theeventum.onrender.com` (Node/Express behind Render + Cloudflare).
- Auth: Google OAuth (`/auth/google` → accounts.google.com, client_id 283386476365-ruk16h3bmtk7jugs66gv9h111kvg9sso — a public identifier, not a secret).
- Storage: public Cloudflare R2 bucket `pub-623ee5f624134dedb9f1765f0f4a8af8.r2.dev` (images).
- Subdomains found in Certificate Transparency (crt.sh): only `www.theeventum.com`.

## Findings

### 1. HIGH — API reflects any Origin and allows credentials (CORS misconfiguration)
Evidence observed:
```
$ curl -D - -H "Origin: https://evil.example" https://theeventum.onrender.com/api
access-control-allow-credentials: true
access-control-allow-origin: https://evil.example

$ curl -X OPTIONS -H "Origin: https://evil.example" -H "Access-Control-Request-Method: POST" ...
HTTP/2 204
access-control-allow-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE
access-control-allow-credentials: true
access-control-allow-origin: https://evil.example
```
The API echoes back whatever Origin the caller sends, including with session credentials enabled and all
write methods permitted on preflight. This is the classic `cors({ origin: true, credentials: true })` pattern.

Impact: any web page on any domain that a logged-in Eventum user visits can call
`theeventum.onrender.com/api/*` in the background and **read the responses**. With cookies sent, that is
account data and, because PUT/PATCH/POST/DELETE are allowed, potentially account modification — full
cross-site account takeover driven from an attacker's page.
Caveat, stated honestly: I confirmed the reflection and the credentials flag directly. Whether the session
is carried in a cookie (vs a bearer token in localStorage) decides exploitability, and I could not verify that
without an authenticated session. The header configuration is wrong either way.

Fix: allowlist exact origins instead of reflecting:
```js
app.use(cors({
  origin: ["https://www.theeventum.com", "https://theeventum.com"],
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE"],
}));
```
Reject unknown origins (403) rather than reflecting them, and confirm no `Access-Control-Allow-Origin: *`
remains on any route.

### 2. HIGH/MEDIUM — Unauthenticated API endpoint exposes user identifiers and organizer contact data
Evidence observed: `GET https://theeventum.onrender.com/api/events` returns HTTP 200 with 55.6 KB of JSON
and no authentication. Each event object includes `registeredUsers` (array of internal MongoDB user IDs),
`attendedUsers`, `createdBy`, and organizer `email` / `phone` / `contacts` values.
Measured count: **497 unique user IDs** of registered students across 5 events, plus 5 distinct organizer
emails and 5 phone numbers.
```
"registeredUsers":["6a89c1279a707def64d8004c","6ab696c8a5de975d4bc7c8f7", ...], "createdBy":"69d6ac1faf4bb2156bac9d5c"
```
Impact: the registration list of every event (who signed up) is public and enumerable. Internal user IDs are
the key an IDOR (insecure direct object reference) attack needs; combined with finding 1 this becomes a
practical route to reading other students' profiles. In an Indian campus context, registration lists paired
with student identity are personal data under the DPDP Act.
Fix: never return raw database documents to an anonymous caller. Use a projection/DTO:
```js
Event.find(publicFilter, 'title description date venue organizer.name image capacity category')
```
Keep `registeredUsers`, `attendedUsers`, `createdBy`, `contacts` and any `email`/`phone` behind auth and an
ownership/role check. Return only counts (e.g. `registeredCount`) publicly. Also verify the same projection on
`/api/clubs`, which publishes `presidentEmail` and `organizerAccount`.

### 3. MEDIUM — Front end ships no security headers; the app can be framed (clickjacking)
Evidence observed, exact header set from `https://www.theeventum.com/`:
```
access-control-allow-origin: *
strict-transport-security: max-age=63072000
(no content-security-policy, no x-frame-options, no x-content-type-options,
 no referrer-policy, no permissions-policy, no set-cookie)
```
The API host is well configured (helmet: CSP, `x-frame-options: SAMEORIGIN`, `nosniff`, HSTS with
includeSubDomains) — the HTML host is not, which is where a user actually lands.
Impact: the SPA renders inside a third-party iframe with no restriction, so an attacker can overlay it and
harvest clicks aimed at "Sign in with Google" or a registration button (UI redressing). Missing CSP means a
single injected script has no second line of defence; missing `nosniff`/`Referrer-Policy` widen the blast
radius; `access-control-allow-origin: *` on the HTML is inconsistent with the locked-down API.
Fix: add response headers in `vercel.json`:
```json
{ "headers": [{ "source": "/(.*)", "headers": [
  { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://pub-623ee5f624134dedb9f1765f0f4a8af8.r2.dev; frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { "key": "X-Frame-Options", "value": "DENY" },
  { "key": "X-Content-Type-Options", "value": "nosniff" },
  { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
  { "key": "Permissions-Policy", "value": "geolocation=(), microphone=(), camera=()" },
  { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains" }
]}]}
```
Then tighten CSP in report-only mode first and remove `'unsafe-inline'` once inline styles are gone.
Consider adding `integrity` (SRI) to the JS/CSS tags — neither currently has it.

### 4. LOW — No CAA record
Evidence: DNS query for `theeventum.com CAA` returns no answer (authority SOA only — i.e. no record).
Impact: any public CA may issue a certificate for this domain. With a valid Let's Encrypt cert in use
(issued Sep 7 2026, expires Dec 6 2026, SAN `www.theeventum.com` only), a mis-issuance would go unnoticed.
Fix: publish `0 issue "letsencrypt.org"`.

### 5. LOW — No SPF or DMARC record; domain cannot receive mail
Evidence: `TXT theeventum.com` returns only the Google site-verification string — no `v=spf1`. No MX record
exists, and `_dmarc.theeventum.com` has no TXT record.
Impact: the domain cannot receive email at all, so mailbox impersonation is not the risk here. The remaining
risk is third parties receiving spoofed mail with a `@theeventum.com` From/Return-Path.
Fix: `v=spf1 -all` and `_dmarc` TXT `v=DMARC1; p=reject; rua=mailto:dmarc@theeventum.com` (adjust if the
domain is ever given a mailbox). If the address is used to send, add DKIM as well.

### 6. INFO — Good practices observed (no action needed)
- TLS: only TLS 1.2 and 1.3 accepted (TLS 1.1 refused); certificate valid and correctly named.
- Every path tested for exposed files returned 404 with a uniform body: `.git/config`, `.env`,
  `.env.local`, `vercel.json`, `package.json`, `.well-known/security.txt`, and the JS source map.
- No API keys or secrets in the front-end bundle (no Google AI keys, no Stripe/AWS keys, no JWTs). The
  Google OAuth client_id present is public by design. No serialized user objects in the bundle.
- R2 media bucket does not allow path listing (`?list-type=2` → 404).
- App-level auth boundaries hold for what I tested: `/api/organizer/events` and `/api/organizer/notifications`
  return 401 unauthenticated; unknown `/api/users/:id` style routes 404 rather than leaking.
- Transport hygiene: http → https and apex → www both 308 redirect.

### 7. INFO — Minor information disclosure
- API 404s leak the framework: `Cannot GET /nonexistent-xyz` (Express default handler).
- Vercel/Render deployment IDs echoed in headers (`x-vercel-id`, `rndr-id`).
- Neither is exploitable alone; worth cleaning up if you harden the app anyway.

## Not tested (deliberately, or out of scope)
- Authenticated testing: no account was created or used, so role checks, IDOR reachability from a real
  session, and cookie flags on the session cookie are unverified. This is the biggest open question, and it
  is also what would settle finding 1's real severity.
- No brute force, no password or OTP attempts, no destructive or data-modifying injection, no load/DoS testing.
- Open redirect: I tried `redirect=` / `next=` on the OAuth start routes with an external target; the response
  always went to Google, so no redirect was injected. Not exhaustively fuzzed.
- Third-party systems were identified but not probed: Vercel edge, Render, Cloudflare, Google OAuth,
  Google Fonts, X (Twitter)/Instagram links. Note: `theeventum.onrender.com:8080` answers 403 from
  Cloudflare — that is Cloudflare's own edge on the shared `onrender.com` domain, not an Eventum service,
  so it is not a finding about this site.
- Port scanning beyond a handful of common ports on the app host (80, 443 open; 21, 22, 3000, 5432, 8000,
  27017 closed/filtered).

## Priority order
1. Fix the API CORS policy (finding 1) today — one line of server config.
2. Stop returning `registeredUsers`/contact data to anonymous callers (finding 2).
3. Add the security headers to the Vercel front end (finding 3).
4. CAA, SPF and DMARC records (findings 4-5).
