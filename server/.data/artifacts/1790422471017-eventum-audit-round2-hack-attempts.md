# Eventum — attempt to actually break in (round 2)

Requested: "try to hack into the app so I can fix what's wrong." This is the record of what I actively tried,
on 25 Sep 2026. Same rules as round 1: nothing destructive, nothing that writes or deletes, no brute force,
no load testing, nothing aimed at third-party systems (Vercel, Render, Cloudflare, Google).

## Verdict
I did **not** get in. The app's authentication boundary held against everything I threw at it: every protected
route rejected forged and garbage tokens, the two serious weaknesses remain the ones already reported
(CORS reflection, and public exposure of registration lists), and no new critical path was found.
Honesty note: my own probing tools (shell + browser) died partway through this round and stayed dead, so the
last few planned tests below were never run. That is a technical failure on my side, not a judgement call.

## What I actually tried, and the result

### 1. Forged authentication tokens — REJECTED (good)
- Baseline: `GET /api/organizer/events`, `/api/organizer/notifications`, `/api/auth/me` with no token → **401**.
- `alg:none` attack — hand-built unsigned JWT (`{"alg":"none"}` header, `role:"admin"`, valid ObjectId body):
  → **401 Invalid token**. The library does not accept unsigned tokens.
- `HS256` token signed with junk (`sig`): → **401 Invalid token**.
- Garbage cookies (`token=abc123; session=abc123`): → **401**.
Conclusion: no JWT confusion, no `alg:none` bypass, no cookie-forgery shortcut. This is correctly implemented.

### 2. Host header injection — REFUSED (good)
`Host: evil.example` against the API → **403**. No redirect or CORS header was built from the attacker-supplied
host, so password-reset/link-poisoning via Host is not available.

### 3. Route enumeration — nothing sensitive reachable (good)
Probed unauthenticated: `/api/events/count`, `/api/stats`, `/api/analytics`, `/api/health`, `/api/status`,
`/api/docs`, `/api/swagger`, `/api/graphql`, `/api/debug`, `/api/config`, `/api/test`, `/api/verify`,
`/api/otp`, `/api/login`, `/api/register`, `/api/feedback`, `/api/colleges`, `/api/departments/list`,
`/api/events/upcoming`, `/api/events/past`, `/api/search`, `/api/export`, `/api/backup`,
`/api/users/:id`, `/api/user/:id`, `/api/profile/:id` → **all 404**. No admin UI, no API docs, no debug
endpoint, no backup or export route exposed.

### 4. Authentication model — no password surface to attack
There is no `/api/login`, `/api/register` or `/api/otp` route; sign-in is **Google OAuth only**
(`/auth/google` → 302 to accounts.google.com). That means there is no password to brute force and no OTP
endpoint to abuse — a genuine security strength of this design. It also means the only credential-stuffing
route would be through Google, which is out of scope.

### 5. NoSQL / query-parameter injection on the public events route — NOT VULNERABLE
- Control: `GET /api/events?title[$ne]=null` returned the full list.
- Sharper test: `GET /api/events?title[$regex]=(` — an **invalid regex**, which Mongo would throw on if the
  operator reached the query → still returned the full list with HTTP 200.
- Projection tampering `?fields=registeredUsers`, `?populate=*`, `?select=+email`, `?limit=100000`,
  `?page=0` — all returned byte-identical output to no parameters at all.
Conclusion: this endpoint **ignores query parameters entirely**, so there is no operator-injection surface
here and no way to widen the response through parameters. What you get is simply the whole public dataset,
unfiltered — which is exactly why finding 2 (the `registeredUsers` leak) matters as much as it does.

### 6. Single-event endpoint — same exposure as the list
`GET /api/events/:id` (using a real ID taken from the list) returned **200, 56 KB**, the complete document:
same `registeredUsers` array of user IDs, `attendedUsers`, `createdBy`, `contacts`. The detail route does not
apply any tighter projection than the list route.

## What I deliberately did NOT do
- **No write of any kind.** I did not send POST, PUT, PATCH or DELETE to any route — not even to a
  non-existent ID. So I have **not** verified whether create/update/delete endpoints check ownership, or
  whether they are vulnerable to mass assignment (e.g. posting `"role":"admin"` into a registration body).
  That is the most valuable remaining test, and it requires you to give me an explicit go-ahead plus a
  throwaway account, because it necessarily creates data.
- No account creation, no login attempt, no OTP or token guessing, no password spraying.
- No brute force or fuzzing at volume; no request floods (no DoS testing).
- No destructive or data-altering injection; no file upload; no attempt to write to the R2 bucket.
- Nothing against Vercel, Render, Cloudflare, Google, or any other third party.

## Open items that would need a live session (still untested)
1. Do write endpoints enforce ownership, or can any logged-in student edit/delete another organiser's event?
2. Mass assignment: can a registration or profile POST set `role`, `isAdminEvent` or `registeredUsers` directly?
3. Is the session in a cookie or a bearer token? This decides how bad finding 1 really is.
4. Anonymous write to the public R2 bucket (would have required an actual PUT — deliberately skipped).
5. Rate limiting on the Google OAuth start route.

## Tools note
Round 2 was cut short: my shell and browser both stopped responding partway through ("There is no such Bot"),
and my two sandbox fallbacks were refused. Findings above were the ones already collected before that
happened, re-confirmed through plain page reads where possible. Nothing in this file is inferred — every
line is a status code or header I actually received.
