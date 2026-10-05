/**
 * Neon Auth, as this deployment's identity provider.
 *
 * This is a Managed Better Auth service, not the `better-auth` package: a hosted endpoint reached
 * over HTTPS at `NEON_AUTH_BASE_URL`, with its users in the `neon_auth` schema of the same database
 * this process already holds. It is API-compatible with Better Auth — the endpoints below are
 * Better Auth's own, at the same paths — so the sign-in screen's calls are unchanged apart from
 * where they are sent.
 *
 * THE PROXY IS THE WHOLE POINT, and the alternative was rejected deliberately. Neon Auth hands out
 * an HTTP-only cookie scoped to its own host, so a browser talking to it directly from the app's
 * origin would have to send credentials across origins on every call and hold a session the API
 * server cannot see — and `/api/me`, which every page loads, is answered by the API server. Two
 * arrangements follow from that and both are bad: the browser would have to read the session out of
 * a third-party cookie and hand it to this server on every request, or `/api/me` would move to the
 * browser and every route behind `requireUser` would lose the one thing it depends on.
 *
 * So `/api/auth/*` is proxied to Neon here, in the server the browser already talks to. The cookie
 * the browser holds is this deployment's own, the existing `client()` helper needs no change, and
 * `requireUser` keeps reading a cookie out of `context.req.raw.headers` exactly as it did.
 *
 * WHAT THIS DOES NOT DO. It does not run Better Auth, so none of the plugins the old
 * `auth/index.ts` configured exist here: no username sign-in, no company SSO, no Okta or Entra,
 * no email OTP. Google, email and password, sign-out and the session are the whole surface. That is
 * the provider's list, not a preference — its OpenAPI schema has no route for any of the others —
 * and the sign-in screen is driven by `/api/capabilities`, so it draws buttons for exactly what
 * this can answer.
 */
import { eq, sql } from "drizzle-orm";
import type { AuditEventInput, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { AuthProviderId } from "../config";
import type { AuthService } from "./guards";

/** Where Neon Auth lives, and how it was told about the deployment's own origin. */
/**
 * What this branch's provider will accept, as the provider itself reports it.
 *
 * Read out of `neon_auth.project_config`, a row the provider owns and writes: `social_providers` is
 * the list of OAuth providers configured on this branch, `email_and_password` whether a password form
 * would work, `allow_localhost` whether a `localhost` origin is trusted. A deployment that drew its
 * sign-in screen from its own environment instead would be answering the question "what did I write
 * down" when what matters is "what will this branch accept", and the difference shows up as a button
 * that fails on somebody's first attempt.
 */
export type NeonAuthSettings = {
  /** Provider ids as the provider spells them, narrowed to the ones this product offers. */
  socialProviders: AuthProviderId[];
  emailPassword: boolean;
  /** Whether the provider wants a verified address before the account is usable. */
  requireEmailVerification: boolean;
};

/**
 * The provider's configuration for this branch, or undefined when it cannot be read.
 *
 * Returns undefined rather than a default on any failure — no row, malformed JSON, a provider that
 * has renamed a key — because a default here is indistinguishable from a real answer. `index.ts`
 * reports the difference and carries on with the defaults already in `config.ts`, which is the right
 * way round: a sign-in screen offering one button too many is a nuisance somebody can click past,
 * while refusing to start takes the product down over one row.
 *
 * The read is direct SQL against a table in the same database this process already holds a pool to,
 * rather than an HTTPS call, and the reason is that this runs on every start of every replica: it is
 * one indexed row on a connection that is already open, where the HTTPS call would be a fresh TLS
 * handshake to another host before the process has served a single request.
 */
export async function readNeonAuthSettings(
  database: Database,
  baseUrl: string,
  origin: string,
): Promise<NeonAuthSettings | undefined> {
  const base = baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/get-session`, {
      method: "GET",
      headers: { Origin: origin, Accept: "application/json" },
      redirect: "manual",
    });
    /*
     * The call above is not for its body. It is to confirm the provider is reachable and to make it
     * send CORS headers for our origin, which is the origin the real proxied calls will carry. If it
     * refuses, nothing else here will work either and the reason is worth having before the process
     * starts serving.
     */
    if (!response.ok && response.status !== 401) {
      console.error(
        JSON.stringify({
          type: "neon-auth-unreachable",
          status: response.status,
          note: "Neon Auth did not answer. Sign-in will not work until it does; everything else in this deployment is unaffected.",
        }),
      );
      return undefined;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "neon-auth-unreachable",
        error: String(error),
        note: "Neon Auth could not be reached, so the sign-in screen falls back to the defaults in config.ts.",
      }),
    );
    return undefined;
  }

  try {
    /*
     * `project_config` is the provider's own row and its shape is not a contract this process can
     * rely on: it is a JSONB column whose keys have changed across provider versions. So it is read
     * as JSON and every field is checked rather than assumed, and anything unrecognised leaves that
     * one setting at its default instead of failing the read.
     */
    const rows = (await database.execute(sql`
      select trusted_origins, social_providers, email_and_password,
             allow_localhost
      from neon_auth.project_config
      limit 1
    `)) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return undefined;

    const social = Array.isArray(row.social_providers)
      ? row.social_providers
          .map((provider) =>
            provider && typeof provider === "object"
              ? (provider as { id?: unknown }).id
              : provider,
          )
          .filter(
            (provider): provider is AuthProviderId =>
              provider === "google" ||
              provider === "github" ||
              provider === "vercel",
          )
      : [];

    const email = row.email_and_password;

    return {
      socialProviders: social,
      emailPassword:
        email && typeof email === "object"
          ? (email as { enabled?: unknown }).enabled === true
          : false,
      requireEmailVerification:
        email && typeof email === "object"
          ? (email as { requireEmailVerification?: unknown })
              .requireEmailVerification === true
          : false,
    };
  } catch (error) {
    /*
     * Absent rather than fatal, and the message says which of the two it was: the schema may not be
     * there because auth was never provisioned on this branch, which is a different problem from the
     * row being unreadable, and an operator reading one line should be able to tell them apart.
     */
    console.error(
      JSON.stringify({
        type: "neon-auth-settings-unreadable",
        error: String(error),
        note: "Could not read neon_auth.project_config. Check that `auth: true` is in neon.ts and `neon deploy` has run on this branch; until then the sign-in screen falls back to the defaults in config.ts.",
      }),
    );
    return undefined;
  }
}

export type NeonAuthConfig = {
  baseUrl: string;
  /**
   * This deployment's own public address, e.g. `https://remii.app`.
   *
   * Sent as `Origin` on every call. Neon Auth answers CORS from an allowlist it keeps in
   * `neon_auth.project_config`, and an origin that is not on it is refused — so a proxied request
   * that arrived without an `Origin` would be rejected by the provider for a reason that has
   * nothing to do with who is signing in. This deployment's address is the one on that list by
   * definition, and the localhost spellings are pre-configured by Neon for exactly this reason.
   */
  origin: string;
};

type SessionUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  emailVerified?: boolean;
};

/**
 * The cookie the provider mints its session into, as it appears on the wire between this server and
 * Neon.
 *
 * Separate from `NEON_AUTH_SESSION_COOKIE` below on purpose. The two are different names for the same
 * token, and conflating them is a bug this file had once: the upstream name was not in the rewriting
 * table, so every sign-up returned 200 with a session and handed the browser a cookie with an empty
 * value — signed in to nothing, and silent about it.
 */
export const NEON_AUTH_COOKIE = "__Secure-neon-auth.session_token";

/**
 * The names this deployment may hand the browser its session under.
 *
 * The `__Host-` form is the one a deployed instance uses and is worth having: a browser will only
 * store such a cookie if it carries `Secure`, if it has no `Domain` attribute, and if its `Path` is
 * `/`. That makes cookie-planting from a sibling subdomain impossible rather than merely unlikely,
 * and it cannot be relaxed by accident because the browser enforces all three.
 *
 * THE UNPREFIXED NAME EXISTS FOR LOCAL DEVELOPMENT, and it is not a fallback anybody chose. `__Host-`
 * REQUIRES `Secure`, and a browser refuses a `__Host-` cookie that arrives without it — silently, with
 * no error and no log line. Local development is plain HTTP on port 3010, so the prefixed name is
 * simply discarded: sign-in answers 200, the cookie is never stored, and every subsequent request is
 * unauthenticated. That is the most confusing possible failure, and it is why both names are read.
 *
 * So `cookieName` below picks per deployment, and `readSessionCookie` accepts either. A deployed
 * instance over TLS only ever writes the prefixed one.
 */
export const NEON_AUTH_SESSION_COOKIE = "__Host-neon_auth_session";
const NEON_AUTH_SESSION_COOKIE_INSECURE = "neon_auth_session";

/**
 * The cookie header to send upstream, rebuilt rather than forwarded.
 *
 * This is the crux of the proxy. The browser sends `__Host-neon_auth_session`; Neon Auth expects
 * `__Secure-neon-auth.session_token` and nothing else will authenticate. So the incoming cookie is
 * dropped and a new header carrying only that one name is sent, which also means no cookie the
 * browser happens to be holding for this origin can be relayed to the provider.
 */
function upstreamCookieHeader(request: Request): string | undefined {
  const value = readSessionCookie(request.headers.get("cookie"));
  return value ? `${NEON_AUTH_COOKIE}=${value}` : undefined;
}

/**
 * The session token out of a `Cookie` header, or undefined.
 *
 * NOT DECODED, and that is the whole subtlety of this function. The provider's token is already
 * percent-encoded — it ends `…qXcHoZu281g7dv8LowO%2B6eWxG8K5kP6xiJ3hRldhR8s%3D` — because a cookie
 * value may not carry a raw `+` or `=`. So decoding here and re-encoding on the way upstream turns
 * `%3D` into `%253D`, and the provider is handed a token that does not exist. Sign-in then answers 200,
 * stores a cookie, and every later request is refused, which is the same failure as no session at all
 * with one more step in front of it.
 *
 * The value is therefore carried verbatim in both directions: this deployment renames the cookie and
 * nothing else, so the provider receives byte-for-byte what it issued.
 */
function readSessionCookie(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    // Both names, because a deployment that has just been moved behind TLS has cookies written under
    // the unprefixed one, and reading only the prefixed name would sign every existing person out at
    // the moment the switch was made. See the note on the constant above.
    if (
      name !== NEON_AUTH_SESSION_COOKIE &&
      name !== NEON_AUTH_SESSION_COOKIE_INSECURE
    ) {
      continue;
    }
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * Every `Set-Cookie` from Neon, rewritten to belong to this origin.
 *
 * Neon's cookie cannot be passed through as it stands: it is `__Secure-` prefixed, which a browser
 * will only accept from an HTTPS origin with no `Domain` attribute, and it is `HttpOnly; Secure;
 * SameSite=None; Partitioned`. Relayed verbatim, a local development browser silently refuses to
 * store it, and the failure surfaces as "sign-in did nothing" rather than as a cookie error.
 *
 * So the name and every attribute are replaced. `SameSite=Lax` rather than `None`: the session is
 * same-origin now, and `Lax` is the tighter value that still survives a top-level OAuth redirect
 * back into this deployment, which is the one cross-site navigation that has to carry it. The value
 * is the same opaque token.
 */
function rewriteSetCookie(value: string, secureOrigin: boolean): string {
  const name = secureOrigin
    ? NEON_AUTH_SESSION_COOKIE
    : NEON_AUTH_SESSION_COOKIE_INSECURE;
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secureOrigin ? ["Secure"] : []),
  ];
  return attributes.join("; ");
}

/**
 * The session token out of one `Set-Cookie` header, or undefined when it is not the session's.
 *
 * Matched against the provider's name and the plain one Better Auth uses when it runs behind a
 * hostname that does not need the `__Secure-` prefix. Guessing at a third would be worse than
 * matching two: an unmatched name produces a cookie with no value, which a browser stores happily
 * and which reads as "signed in to nothing" rather than as an error.
 */
function readSessionTokenValue(setCookie: string): string | undefined {
  const [pair] = setCookie.split(";");
  const separator = pair.indexOf("=");
  if (separator === -1) return undefined;
  const name = pair.slice(0, separator).trim();
  if (name !== NEON_AUTH_COOKIE && name !== "better-auth.session_token") {
    return undefined;
  }
  return pair.slice(separator + 1).trim();
}

/**
 * Build the auth service, given the database and the audit trail to write sign-ins to.
 *
 * The database is here for one job: `neon_auth.user` holds the identity and `public.users` holds
 * everything the product knows about a person — their balance, their billing ids, their onboarding
 * step, and the 39 foreign keys that point at them. A person who signs in through Google exists in
 * the first and not the second until something creates the row, and every one of those 39 columns
 * is `NOT NULL`-by-reference into a table that has to have them. So a first sign-in provisions one.
 */
export function createNeonAuth(
  neon: NeonAuthConfig,
  database: Database,
  auditStore?: AuditStore,
): AuthService {
  const base = neon.baseUrl.replace(/\/+$/, "");
  /*
   * Whether this deployment is served over TLS, decided once from the configured address rather
   * than per request. `X-Forwarded-Proto` would be the alternative and is not used: it is a header
   * a client sets, so a cookie's `Secure` attribute decided from it is a decision the client makes.
   */
  const secureOrigin = neon.origin.startsWith("https://");

  const fetchNeon = async (
    path: string,
    init: { method?: string; body?: string; cookie?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers();
    headers.set("Origin", neon.origin);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    if (init.cookie) headers.set("Cookie", init.cookie);
    return fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      body: init.body,
      headers,
      redirect: "manual",
    });
  };

  return {
    /**
     * `/api/auth/*`, forwarded.
     *
     * The path after `/api/auth` is preserved verbatim, so the sign-in screen calls
     * `/api/auth/sign-in/email` and this calls `{base}/sign-in/email`, which is the provider's own
     * route. `redirect: "manual"` because the social sign-in answers with a 302 to Google: followed
     * automatically, this server would fetch Google's consent page and hand a person their own login
     * form as an API response.
     */
    handler: async (request) => {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/auth/, "") || "/";
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.text();
      const cookie = upstreamCookieHeader(request);

      const upstream = await fetchNeon(`${path}${url.search}`, {
        method: request.method,
        ...(body === undefined ? {} : { body }),
        ...(cookie === undefined ? {} : { cookie }),
      });

      const headers = new Headers();
      /*
       * Content type and status only.
       *
       * Deliberately narrow. Hop-by-hop headers, `Content-Encoding`, `Content-Length` and Neon's own
       * `x-neon-*` tracing are all about the hop between here and Neon, and relaying them describes
       * a response that no longer exists once the body has been re-framed by `fetch`. The body is
       * read as text and handed back, which drops the original encoding, so passing the original
       * `Content-Encoding` through would have the browser try to inflate plain text.
       */
      const contentType = upstream.headers.get("Content-Type");
      if (contentType) headers.set("Content-Type", contentType);
      // `vary: Origin` matters to nothing here — this response is built per-origin by construction —
      // and `Location` must survive untouched: it is the Google URL, and rewriting it would break
      // the OAuth handshake that the whole redirect dance exists to perform.
      const location = upstream.headers.get("Location");
      if (location) headers.set("Location", location);
      for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
        /*
         * Only the session cookie is relayed, and only when it carries a value.
         *
         * A provider that sends several `Set-Cookie` headers — clearing a stale session while setting
         * a new one, for instance — would otherwise have every one of them rewritten into an empty
         * `__Host-` cookie, and the browser stores those as well as the real one. The last write wins,
         * so an empty value arriving after the session would leave a signed-out browser holding a
         * cookie that looks valid.
         */
        const value = readSessionTokenValue(cookie);
        if (value === undefined) continue;
        headers.append("Set-Cookie", rewriteSetCookie(value, secureOrigin));
      }

      return new Response(await upstream.text(), {
        status: upstream.status,
        headers,
      });
    },

    /*
     * Finish an OAuth sign-in, once the browser is back on THIS origin.
     *
     * This exists because the proxy cannot finish an OAuth flow, and the reason is structural rather
     * than a bug in it. Google redirects to `{NEON_AUTH_BASE_URL}/callback/google`, which is the
     * PROVIDER's host, so the provider sets its session cookie there and the browser returns to this
     * application holding nothing for this origin. Every proxied call above works, because every one
     * of them is this server talking to the provider; the OAuth round trip is the one flow where the
     * browser is the one talking, and it talks to somebody else.
     *
     * This route is the shape of the answer and is not yet reachable. The blocker is written down at
     * the `fetchNeon` call below and in `docs/deployment.md`: the browser cannot hand over the
     * provider's session cookie, because that cookie is `HttpOnly` and belongs to the provider's host.
     *
     * THE TOKEN IS NOT TRUSTED, and the round trip is what makes that true rather than merely
     * intended. A token that arrived in a request body is a string somebody chose, so it is presented
     * to the provider and the provider's answer is what is acted on. A cheaper version of this exists
     * — the provider also issues a JWT, and verifying its signature against the published JWKS needs no
     * network at all — and it is the wrong one here: it would make this the only place in the codebase
     * that decides who somebody is without asking the provider, and a hand-rolled session validation
     * is a thing that drifts from the provider and fails open.
     *
     * The cookie written is the provider's own opaque session token under this origin's name, so from
     * here on the whole flow above applies unchanged and `getSession` reads it as it reads any other
     * session. Nothing about a request's authentication depends on this route.
     */
    completeSocialSignIn: async (request) => {
      let token: string;
      try {
        const body = (await request.json()) as { token?: unknown };
        if (typeof body?.token !== "string" || body.token === "") {
          return Response.json(
            { error: "A session token is required to finish signing in." },
            { status: 400 },
          );
        }
        token = body.token;
      } catch {
        return Response.json(
          { error: "A session token is required to finish signing in." },
          { status: 400 },
        );
      }

      /*
       * Who that token belongs to, according to the provider.
       *
       * The same call `getSession` makes, with the same cookie, and deliberately so: there is one
       * place in this file that asks the provider what a session is, and a sign-in completing is the
       * same question as a request arriving. Two code paths would be two chances to disagree about
       * what counts as signed in.
       *
       * THE TOKEN ARRIVES AS THE PROVIDER ISSUED IT, which is not the same as what
       * `GET /get-session` reports. A cookie value is `<session-token>.<signature>`; the response's
       * `session.token` is the first half alone, and the provider does not accept that as a session —
       * checked rather than assumed, because it is the shape a reading of that endpoint suggests and
       * the one thing here that would fail silently.
       *
       * So what arrives here has to be the signed form. HOW IT GETS HERE IS NOT SOLVED, and that is
       * why this route is not wired to anything: the cookie is `HttpOnly` and scoped to the provider's
       * host, so a page on this origin cannot read it and cannot send it here either. The provider's
       * own `callbackURL` mechanism is the one that puts a browser back on this origin, and it does so
       * without the cookie.
       */
      let user: SessionUser | null = null;
      try {
        const response = await fetchNeon("/get-session", {
          method: "GET",
          cookie: `${NEON_AUTH_COOKIE}=${token}`,
        });
        if (response.ok) {
          const payload = (await response.json()) as {
            user?: SessionUser;
          } | null;
          user = payload?.user ?? null;
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "neon-auth-session-exchange-failed",
            error: String(error),
            note: "Neon Auth could not be reached to confirm a session presented after an OAuth redirect, so no cookie was issued and the person must sign in again.",
          }),
        );
      }

      if (!user?.email) {
        /*
         * 401, and it says nothing about which of the reasons it was. A caller that could tell "the
         * token was unknown" from "the provider was unreachable" could work through them one at a
         * time; the reasons went to the log, where an operator can read them.
         */
        return Response.json(
          { error: "That sign-in could not be completed." },
          { status: 401 },
        );
      }

      const local = await ensureLocalUser(database, user, auditStore);
      if (!local) {
        return Response.json(
          { error: "That sign-in could not be completed." },
          { status: 503 },
        );
      }

      return Response.json(
        { ok: true, user: { id: local.id, email: local.email } },
        { headers: { "Set-Cookie": rewriteSetCookie(token, secureOrigin) } },
      );
    },

    api: {
      /**
       * Who the session cookie belongs to, provisioning their product row on a first sign-in.
       *
       * Called on every authenticated request, so the provider call is the cost that matters. Neon
       * answers `{ user, session }` for a valid cookie and `null` for anything else, which is one
       * HTTPS request to a service in the same region as this database.
       *
       * The alternative — reading `neon_auth.session` and `neon_auth.user` out of the database this
       * process already holds a pool to — is not done, and the reason is that it would be a second,
       * hand-written implementation of Better Auth's session validation, kept in step with the
       * provider's by hand. One HTTPS call that cannot drift is cheaper than a cache that can.
       */
      getSession: async ({ headers }) => {
        const cookie = readSessionCookie(headers.get("cookie"));
        if (!cookie) return null;

        let payload: { user?: SessionUser } | null = null;
        try {
          const response = await fetchNeon("/get-session", {
            method: "GET",
            cookie: `${NEON_AUTH_COOKIE}=${cookie}`,
          });
          if (!response.ok) return null;
          payload = (await response.json()) as { user?: SessionUser } | null;
        } catch (error) {
          /*
           * A provider that cannot be reached is not a signed-out person. Refusing the request would
           * tell every signed-in user they were signed out during a Neon blip, so this says so
           * loudly and then answers as though they were, which is the same failure the audit store
           * has always had: an unavailable trail must not stop somebody working.
           */
          console.error(
            JSON.stringify({
              type: "neon-auth-session-lookup-failed",
              note: "Neon Auth could not be reached, so this request is refused as unauthenticated. Every signed-in user sees a sign-in screen until it recovers.",
              error: String(error),
            }),
          );
          return null;
        }

        const user = payload?.user;
        if (!user?.email) return null;

        const local = await ensureLocalUser(database, user, auditStore);
        if (!local) return null;

        return {
          user: {
            id: local.id,
            email: local.email,
            name: local.name,
            image: local.image,
          },
        };
      },
    },
  };
}

/**
 * The product's own row for a person who has just authenticated.
 *
 * `neon_auth.user.id` is a UUID and `public.users.id` is this product's own identifier, which 39
 * foreign keys point at and which the existing rows already hold values for. Rather than re-key
 * those, the Neon id is stored on the row and matched on, so a person who signs in again — by Google
 * or by password — lands on the same row every time and keeps everything attached to it.
 *
 * A row is found by Neon id first and by email second. The second lookup is what carries a person
 * across the switch from the previous provider, where the same email was a row in `public.users`
 * with no Neon id on it; without it, every existing user would come back as a stranger with an
 * empty account and a fresh set of foreign keys, and the migration would have thrown away their
 * conversations.
 *
 * Never fatal. A provisioning failure means the request is refused, because returning a session for
 * a person with no row would fail later and further from the cause.
 */
async function ensureLocalUser(
  database: Database,
  user: SessionUser,
  auditStore: AuditStore | undefined,
): Promise<{
  id: string;
  email: string;
  name: string | null;
  image: string | null;
} | null> {
  try {
    const byAuth = await database
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
      })
      .from(users)
      .where(eq(users.neonAuthUserId, user.id))
      .limit(1);
    if (byAuth[0]) return byAuth[0];

    const byEmail = await database
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
      })
      .from(users)
      .where(eq(users.email, user.email))
      .limit(1);
    if (byEmail[0]) {
      // The existing row, claimed. `onConflictDoNothing` because two requests for the same person
      // can arrive together on a first sign-in, and the second must not fail on the unique index.
      await database
        .insert(users)
        .values({
          id: crypto.randomUUID(),
          email: user.email,
          name: user.name ?? null,
          image: user.image ?? null,
          emailVerified: user.emailVerified === true,
          neonAuthUserId: user.id,
        })
        .onConflictDoNothing();
      await record(
        auditStore,
        "session.signed_in",
        byEmail[0].id,
        "Signed in through Neon Auth and matched an existing account with the same address.",
      );
      await stampLastSignedIn(database, byEmail[0].id);
      return byEmail[0];
    }

    const created = await database
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email: user.email,
        name: user.name ?? null,
        image: user.image ?? null,
        emailVerified: user.emailVerified === true,
        neonAuthUserId: user.id,
      })
      .onConflictDoUpdate({
        // The unique index on email is what two concurrent first sign-ins collide on. Re-running the
        // update under it means the loser adopts the winner's row instead of erroring.
        target: users.email,
        set: {
          neonAuthUserId: user.id,
          emailVerified: user.emailVerified === true,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
      });

    const row = created[0];
    if (!row) return null;
    await record(
      auditStore,
      "session.signed_in",
      row.id,
      "First sign-in through Neon Auth. An account was created for this address.",
    );
    await stampLastSignedIn(database, row.id);
    return row;
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "neon-auth-user-provisioning-failed",
        email: user.email,
        error: String(error),
      }),
    );
    return null;
  }
}

async function stampLastSignedIn(
  database: Database,
  userId: string,
): Promise<void> {
  try {
    const now = new Date();
    await database
      .update(users)
      .set({
        lastSignedInAt: sql`greatest(coalesce(${users.lastSignedInAt}, ${now}), ${now})`,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "sign-in-stamp-write-failed",
        userId,
        error: String(error),
      }),
    );
  }
}

async function record(
  auditStore: AuditStore | undefined,
  eventType: AuditEventInput["eventType"],
  userId: string,
  note: string,
): Promise<void> {
  if (!auditStore) return;
  const event: AuditEventInput = {
    eventType,
    targetType: "person",
    targetId: userId,
    actorUserId: userId,
    payload: { note },
  };
  try {
    await recordAuditEvent(auditStore, event);
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "sign-in-audit-write-failed",
        eventType,
        error: String(error),
      }),
    );
  }
}
