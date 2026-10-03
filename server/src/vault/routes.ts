import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditInitiator, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import {
  VaultNotFoundError,
  VaultRefusedError,
  type VaultStore,
} from "./store";

export type { VaultStore } from "./store";

/**
 * The vault as a person drives it: four sections, each with its own list, form and delete.
 *
 * EVERY ROUTE TAKES ITS OWNER FROM `context.var.actor.id` AND FROM NOWHERE ELSE. There is no `userId`
 * in any path, any query string and any body on this router, and that is the point: a route that takes
 * an owner from a request is a route whose authorization is a suggestion. `requireUser` resolves the
 * id from the session cookie on every one of these handlers, so there is no code path on which a
 * browser can name somebody else's vault.
 *
 * WHAT THE LIST ROUTES RETURN. Masks, never secrets. `GET /logins` has no password in its response
 * and no query that could produce one; the password leaves the server only through
 * `POST /logins/:id/reveal`, which the browser calls because a person clicked "Copy". That split is
 * the whole security story of this file: reading a list cannot disclose a secret, so there is no
 * listing-shaped way to ask this API for somebody's passwords.
 *
 * THE REVEAL ROUTES ARE AUDITED, because a secret leaving the vault is the only event on this surface
 * that cannot be reconstructed from the rows afterwards. The payload carries the item's name and the
 * outcome and never the value — see the `vault.value_read` note in `audit.ts`.
 */
export function createVaultRoutes(
  vaultStore: VaultStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  auditStore?: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Say that a secret was read out of somebody's own vault.
   *
   * Best-effort by design: a person copying a password should not be shown a failure because the
   * trail could not be written. The row on the item itself still records the use, so the record does
   * not depend on this call succeeding.
   */
  const recordRead = async (input: {
    actorUserId: string;
    targetType: string;
    targetId: string;
    label: string;
    initiator?: AuditInitiator;
  }): Promise<void> => {
    if (!auditStore) return;
    try {
      await recordAuditEvent(auditStore, {
        eventType: "vault.value_read",
        targetType: input.targetType,
        targetId: input.targetId,
        actorUserId: input.actorUserId,
        ...(input.initiator ? { initiator: input.initiator } : {}),
        payload: { kind: input.targetType, item: input.label },
      });
    } catch {
      // Swallowed on purpose; see above.
    }
  };

  const recordChange = async (input: {
    actorUserId: string;
    targetType: string;
    targetId: string;
    label: string;
    change: "created" | "updated" | "deleted";
    initiator?: AuditInitiator;
  }): Promise<void> => {
    if (!auditStore) return;
    try {
      await recordAuditEvent(auditStore, {
        eventType: "vault.item_changed",
        targetType: input.targetType,
        targetId: input.targetId,
        actorUserId: input.actorUserId,
        ...(input.initiator ? { initiator: input.initiator } : {}),
        payload: {
          kind: input.targetType,
          item: input.label,
          change: input.change,
        },
      });
    } catch {
      // Swallowed on purpose; see above.
    }
  };

  /*
   * All four sections in one read.
   *
   * The screen shows four sections that are always drawn together and refetched together — deleting a
   * login and adding a card both re-read this page — so one endpoint that answers the whole vault is
   * fewer round trips than four and one shape to reason about. The individual endpoints below stay,
   * because they are what a caller with one job asks for, and because a list that could not be fetched
   * on its own would make the page all-or-nothing.
   *
   * Four reads in parallel rather than one joined query: three of them are separate tables, and a
   * UNION over tables with different columns would mean selecting the union of all of them and
   * discarding most of it in application code. See the header on `db/schema/vault.ts`.
   */
  routes.get("/", requireUser, async (context) => {
    const userId = context.var.actor.id;
    const [logins, cards, personalInfo, agentItems] = await Promise.all([
      vaultStore.listLogins(userId),
      vaultStore.listCards(userId),
      vaultStore.readPersonalInfo(userId),
      vaultStore.listAgentItems(userId),
    ]);
    return context.json({ logins, cards, personalInfo, agentItems });
  });

  /* Logins. -------------------------------------------------------------------------------- */

  routes.get("/logins", requireUser, async (context) => {
    return context.json({
      logins: await vaultStore.listLogins(context.var.actor.id),
    });
  });

  routes.post("/logins", requireUser, async (context) => {
    const read = await readBody(context);
    if (!read.ok) return read.response;
    const body = read.body;

    try {
      const login = await vaultStore.createLogin(context.var.actor.id, {
        label: body.label ?? "",
        username: body.username ?? "",
        password: text(body.password) ?? "",
        websiteUrl: text(body.websiteUrl),
        notes: text(body.notes),
      });
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_login",
        targetId: login.id,
        label: login.label,
        change: "created",
      });
      return context.json({ login }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/logins/:id", requireUser, async (context) => {
    const read = await readBody(context);
    if (!read.ok) return read.response;
    const body = read.body;
    const id = context.req.param("id");

    try {
      const login = await vaultStore.updateLogin(context.var.actor.id, id, {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.username !== undefined ? { username: body.username } : {}),
        ...(body.password !== undefined
          ? {
              password:
                typeof body.password === "string" ? body.password : null,
            }
          : {}),
        ...(body.websiteUrl !== undefined
          ? {
              websiteUrl:
                body.websiteUrl === "" ? null : String(body.websiteUrl),
            }
          : {}),
        ...(body.notes !== undefined
          ? { notes: body.notes === "" ? null : String(body.notes) }
          : {}),
      });
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_login",
        targetId: login.id,
        label: login.label,
        change: "updated",
      });
      return context.json({ login });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/logins/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    try {
      // The label is read before the delete, and only for the trail: the row is gone by the time the
      // audit row is written, and "someone deleted a login" is much less use in a month than "they
      // deleted their Stripe login".
      const before = (await vaultStore.listLogins(context.var.actor.id)).find(
        (login) => login.id === id,
      );
      await vaultStore.removeLogin(context.var.actor.id, id);
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_login",
        targetId: id,
        label: before?.label ?? "(unnamed login)",
        change: "deleted",
      });
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * The password, for the person who just asked for it.
   *
   * POST rather than GET because a secret is not a thing to fetch: a GET is what ends up in a browser
   * history, a prefetch, and a proxy log. This response is never cached and the value is never in a
   * URL.
   */
  routes.post("/logins/:id/reveal", requireUser, async (context) => {
    const id = context.req.param("id");
    try {
      const secret = await vaultStore.readLoginSecret({
        userId: context.var.actor.id,
        id,
      });
      await recordRead({
        actorUserId: context.var.actor.id,
        targetType: "vault_login",
        targetId: secret.id,
        label: secret.label,
      });
      return context.json({ value: secret.password });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /* Cards. --------------------------------------------------------------------------------- */

  routes.get("/cards", requireUser, async (context) => {
    return context.json({
      cards: await vaultStore.listCards(context.var.actor.id),
    });
  });

  routes.post("/cards", requireUser, async (context) => {
    const read = await readBody(context);
    if (!read.ok) return read.response;
    const body = read.body;

    try {
      const card = await vaultStore.createCard(context.var.actor.id, {
        label: body.label ?? "",
        cardholderName: text(body.cardholderName),
        cardNumber: text(body.cardNumber) ?? "",
        expiry: text(body.expiry),
        cvv: text(body.cvv),
        billingAddress: text(body.billingAddress),
        notes: text(body.notes),
      });
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_card",
        targetId: card.id,
        label: card.label,
        change: "created",
      });
      return context.json({ card }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/cards/:id", requireUser, async (context) => {
    const read = await readBody(context);
    if (!read.ok) return read.response;
    const body = read.body;
    const id = context.req.param("id");

    try {
      const card = await vaultStore.updateCard(context.var.actor.id, id, {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.cardholderName !== undefined
          ? {
              cardholderName:
                body.cardholderName === "" ? null : String(body.cardholderName),
            }
          : {}),
        // Absent keeps the stored number. `null` is not offered: replacing a card's number means
        // retyping it, and an accidental null would leave a row the list can no longer mask.
        ...(body.cardNumber !== undefined && body.cardNumber !== ""
          ? { cardNumber: String(body.cardNumber) }
          : {}),
        ...(body.expiry !== undefined
          ? { expiry: body.expiry === "" ? null : String(body.expiry) }
          : {}),
        ...(body.cvv !== undefined
          ? { cvv: body.cvv === "" ? null : String(body.cvv) }
          : {}),
        ...(body.billingAddress !== undefined
          ? {
              billingAddress:
                body.billingAddress === "" ? null : String(body.billingAddress),
            }
          : {}),
        ...(body.notes !== undefined
          ? { notes: body.notes === "" ? null : String(body.notes) }
          : {}),
      });
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_card",
        targetId: card.id,
        label: card.label,
        change: "updated",
      });
      return context.json({ card });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/cards/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    try {
      const before = (await vaultStore.listCards(context.var.actor.id)).find(
        (card) => card.id === id,
      );
      await vaultStore.removeCard(context.var.actor.id, id);
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_card",
        targetId: id,
        label: before?.label ?? "(unnamed card)",
        change: "deleted",
      });
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * One field of one card, for one copy-to-clipboard.
   *
   * `POST` for the same reason as the login reveal, and `field` rather than three routes so the
   * audited surface is one endpoint rather than three: a caller can ask for the number, the expiry or
   * the CVV, and each of those is a secret leaving the vault and belongs in the same place.
   */
  routes.post("/cards/:id/reveal", requireUser, async (context) => {
    const id = context.req.param("id");
    const body = (await context.req.json().catch(() => ({}))) as {
      field?: unknown;
    };
    const field = typeof body.field === "string" ? body.field : "";

    if (!["number", "expiry", "cvv"].includes(field)) {
      return context.json(
        { error: "Ask for the number, the expiry or the CVV." },
        400,
      );
    }

    try {
      const secret = await vaultStore.readCardSecret({
        userId: context.var.actor.id,
        id,
      });
      const value =
        field === "number"
          ? secret.cardNumber
          : field === "expiry"
            ? secret.expiry
            : secret.cvv;
      if (!value) {
        return context.json(
          {
            error: `That card has no ${field === "cvv" ? "CVV" : field} saved.`,
          },
          404,
        );
      }
      await recordRead({
        actorUserId: context.var.actor.id,
        targetType: "vault_card",
        targetId: secret.id,
        label: secret.label,
      });
      return context.json({ value });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /* Personal information. ------------------------------------------------------------------- */

  routes.get("/personal-info", requireUser, async (context) => {
    return context.json({
      personalInfo: await vaultStore.readPersonalInfo(context.var.actor.id),
    });
  });

  routes.put("/personal-info", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return context.json({ error: "Send the details to save." }, 400);
    }

    try {
      const saved = await vaultStore.writePersonalInfo(context.var.actor.id, {
        ...(typeof body.fullName === "string"
          ? { fullName: body.fullName }
          : {}),
        ...(typeof body.preferredName === "string"
          ? { preferredName: body.preferredName }
          : {}),
        ...(typeof body.email === "string" ? { email: body.email } : {}),
        ...(typeof body.phone === "string" ? { phone: body.phone } : {}),
        ...(typeof body.dateOfBirth === "string"
          ? { dateOfBirth: body.dateOfBirth }
          : {}),
        ...(typeof body.address === "string" ? { address: body.address } : {}),
        ...(typeof body.city === "string" ? { city: body.city } : {}),
        ...(typeof body.state === "string" ? { state: body.state } : {}),
        ...(typeof body.country === "string" ? { country: body.country } : {}),
        ...(typeof body.postalCode === "string"
          ? { postalCode: body.postalCode }
          : {}),
        ...(typeof body.company === "string" ? { company: body.company } : {}),
        ...(typeof body.jobTitle === "string"
          ? { jobTitle: body.jobTitle }
          : {}),
        ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      });
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_personal_info",
        targetId: context.var.actor.id,
        label: saved.fullName ?? "Personal information",
        change: "updated",
      });
      return context.json({ personalInfo: saved });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /* Agent items. ----------------------------------------------------------------------------- */

  routes.get("/agent-items", requireUser, async (context) => {
    return context.json({
      agentItems: await vaultStore.listAgentItems(context.var.actor.id),
    });
  });

  routes.post("/agent-items", requireUser, async (context) => {
    const read = await readBody(context);
    if (!read.ok) return read.response;
    const body = read.body;

    try {
      const item = await vaultStore.createAgentItem(context.var.actor.id, {
        label: body.label ?? "",
        kind: text(body.kind) ?? "",
        value: text(body.value) ?? "",
        description: text(body.description),
        scope: text(body.scope) ?? undefined,
        scopeRef: text(body.scopeRef),
        allowedApps: Array.isArray(body.allowedApps)
          ? body.allowedApps.map(String)
          : undefined,
      });
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_agent_item",
        targetId: item.id,
        label: item.label,
        change: "created",
      });
      return context.json({ agentItem: item }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/agent-items/:id", requireUser, async (context) => {
    const read = await readBody(context);
    if (!read.ok) return read.response;
    const body = read.body;
    const id = context.req.param("id");

    try {
      /*
       * Read once each, into a named local. `text(body.kind) !== null ? { kind: text(body.kind)! }`
       * works and is unreadable: the assertion says "I already proved this is not null" to the type
       * checker and says nothing to the reader, and the check is repeated on a call that could in
       * principle return something different.
       */
      const kind = text(body.kind);
      const scope = text(body.scope);

      const item = await vaultStore.updateAgentItem(context.var.actor.id, id, {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(kind !== null ? { kind } : {}),
        // Absent keeps the stored value; an empty string clears it. The form never sends an empty
        // string for "leave it alone", so the distinction has to be made where the field is.
        ...(body.value !== undefined
          ? { value: text(body.value) === "" ? null : text(body.value) }
          : {}),
        ...(body.description !== undefined
          ? {
              description:
                text(body.description) === "" ? null : text(body.description),
            }
          : {}),
        ...(scope !== null ? { scope } : {}),
        ...(body.scopeRef !== undefined
          ? {
              scopeRef: text(body.scopeRef) === "" ? null : text(body.scopeRef),
            }
          : {}),
        ...(Array.isArray(body.allowedApps)
          ? { allowedApps: body.allowedApps.map(String) }
          : {}),
      });
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_agent_item",
        targetId: item.id,
        label: item.label,
        change: "updated",
      });
      return context.json({ agentItem: item });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/agent-items/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    try {
      const before = (
        await vaultStore.listAgentItems(context.var.actor.id)
      ).find((item) => item.id === id);
      await vaultStore.removeAgentItem(context.var.actor.id, id);
      await recordChange({
        actorUserId: context.var.actor.id,
        targetType: "vault_agent_item",
        targetId: id,
        label: before?.label ?? "(unnamed item)",
        change: "deleted",
      });
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/agent-items/:id/reveal", requireUser, async (context) => {
    const id = context.req.param("id");
    try {
      const secret = await vaultStore.readAgentItemSecret({
        userId: context.var.actor.id,
        id,
      });
      await recordRead({
        actorUserId: context.var.actor.id,
        targetType: "vault_agent_item",
        targetId: secret.id,
        label: secret.label,
      });
      return context.json({ value: secret.value });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

/**
 * The body of a create or an edit, read once and given back as strings-or-absent.
 *
 * Every field is `unknown` rather than `string` on purpose, and every route converts before it hands
 * anything to the store. The store validates and says what was wrong; a route that had already
 * narrowed to `string` would be doing the same validation twice, in two files, with two sentences.
 * So the boundary here is deliberately thin: parse, hand over, let the store refuse.
 *
 * `websiteUrl` is included here rather than in a second shape — it is the one field the logins route
 * needs and the other two do not, and a separate reader for it would be a second place where "is this
 * body even an object" is decided.
 */
type VaultBody = {
  label?: string;
  username?: string;
  password?: unknown;
  cardNumber?: unknown;
  cardholderName?: unknown;
  websiteUrl?: unknown;
  expiry?: unknown;
  cvv?: unknown;
  billingAddress?: unknown;
  notes?: unknown;
  kind?: unknown;
  value?: unknown;
  description?: unknown;
  scope?: unknown;
  scopeRef?: unknown;
  allowedApps?: unknown;
};

/** Either the parsed body, or the 400 to answer with instead. */
type BodyResult =
  | { ok: true; body: VaultBody }
  | { ok: false; response: Response };

async function readBody(context: Context): Promise<BodyResult> {
  const body = (await context.req.json().catch(() => null)) as unknown;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: context.json({ error: "Send the details to save." }, 400),
    };
  }
  return { ok: true, body: body as VaultBody };
}

/** A body field as text, or null when it was not text. The store decides whether that is allowed. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof VaultNotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  if (error instanceof VaultRefusedError) {
    return context.json({ error: error.message }, 400);
  }
  throw error;
}
