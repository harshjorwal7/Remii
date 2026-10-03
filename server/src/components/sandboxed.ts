import { and, asc, eq, isNull, or } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { components, sandboxedComponents } from "../db/schema";

/**
 * Components authored in a browser rather than compiled into the build.
 *
 * This exists alongside the React path rather than instead of it. A registered React component is
 * what a customer's own front-end engineers write: it inherits their design system, their component
 * library and their review process, and it is the right primary path. It also costs a deployment.
 * That is fine for engineers and wrong for lightweight edits: a solutions engineer wanting one
 * temporary card, an analyst changing a column heading, and anything a model
 * produces, which cannot be a file in the repository by definition.
 *
 * The governance is the same governance. Saving one writes a row in `components` too, so the grant
 * grid, the published description and the per-Bot decision all work on it unchanged. An operator
 * deciding what a Bot may answer with should never have to know which of the two kinds they are
 * looking at, and two grant surfaces would be two things to keep in step.
 *
 * The source has its own publish gate. Publishing without a rebuild is
 * the entire point of this table and it is also what puts an editor one keystroke from changing what
 * every Bot draws in production. A draft absorbs that: edited freely, previewed against sample
 * arguments, and reaching nobody until somebody publishes it.
 */

export type SandboxedRecord = {
  name: string;
  title: string;
  draftDescription: string;
  draftHtml: string;
  draftCss: string;
  draftJsFunctions: string;
  draftArgumentSchema: Record<string, unknown>;
  publishedHtml: string | null;
  publishedCss: string | null;
  publishedJsFunctions: string | null;
  publishedArgumentSchema: Record<string, unknown> | null;
  sampleArguments: Record<string, unknown>;
  revision: number;
  published: boolean;
  publishedAt: string | null;
  authoredBy: string | null;
  ownerUserId: string | null;
  hasUnpublishedChanges: boolean;
};

/** What a Bot may actually draw with: the published source, or nothing at all. */
export type PublishedSandboxed = {
  name: string;
  html: string;
  css: string;
  jsFunctions: string;
  /**
   * The arguments this component takes, as the author described them.
   *
   * Without this the tool advertises no parameters, and a model told a tool takes nothing calls it
   * with nothing.
   */
  argumentSchema: Record<string, unknown>;
};

export class SandboxedNotFoundError extends Error {
  constructor(name: string) {
    super(`No component is called ${name}.`);
    this.name = "SandboxedNotFoundError";
  }
}

export class SandboxedNameRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxedNameRefusedError";
  }
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

/**
 * The one place a sandboxed component's name is decided.
 *
 * Namespaced so it can never collide with a compiled one. Both kinds share the `components` table
 * and both are tool names the model calls, so a playground save that happened to pick `showBarChart`
 * would quietly take over the renderer for a component the build ships. The prefix makes that
 * impossible rather than unlikely, and it also tells a reader of the audit trail which kind drew
 * something without having to look it up.
 */
export const SANDBOXED_PREFIX = "custom_";

export function sandboxedNameFor(slug: string): string {
  return `${SANDBOXED_PREFIX}${slug}`;
}

export function createSandboxedStore(
  database: Database,
  auditStore: AuditStore,
) {
  async function requireRow(name: string) {
    const [row] = await database
      .select()
      .from(sandboxedComponents)
      .where(eq(sandboxedComponents.name, name))
      .limit(1);
    if (!row) throw new SandboxedNotFoundError(name);
    return row;
  }

  const toRecord = (
    row: typeof sandboxedComponents.$inferSelect,
  ): SandboxedRecord => ({
    name: row.name,
    title: row.title,
    draftDescription: row.draftDescription,
    draftHtml: row.draftHtml,
    draftCss: row.draftCss,
    draftJsFunctions: row.draftJsFunctions,
    draftArgumentSchema: row.draftArgumentSchema as Record<string, unknown>,
    publishedHtml: row.publishedHtml,
    publishedCss: row.publishedCss,
    publishedJsFunctions: row.publishedJsFunctions,
    publishedArgumentSchema: row.publishedArgumentSchema as Record<
      string,
      unknown
    > | null,
    sampleArguments: row.sampleArguments as Record<string, unknown>,
    revision: row.revision,
    published: row.published,
    publishedAt: iso(row.publishedAt),
    authoredBy: row.authoredBy,
    ownerUserId: row.ownerUserId,
    hasUnpublishedChanges:
      row.published &&
      (row.draftHtml !== row.publishedHtml ||
        row.draftCss !== row.publishedCss ||
        row.draftJsFunctions !== row.publishedJsFunctions),
  });

  return {
    /**
     * This person's playground: their own components plus legacy shared rows
     * (written before ownership existed). Nothing of anybody else's: one
     * user's draft is not another user's to read, edit or publish.
     */
    async list(ownerId: string): Promise<SandboxedRecord[]> {
      const rows = await database
        .select()
        .from(sandboxedComponents)
        .where(
          or(
            eq(sandboxedComponents.ownerUserId, ownerId),
            isNull(sandboxedComponents.ownerUserId),
          ),
        )
        .orderBy(asc(sandboxedComponents.title));
      return rows.map(toRecord);
    },

    /**
     * Save a draft.
     *
     * The `components` row is written at the same time, unpublished, so the new component appears in
     * the grid straight away and no Bot can draw it yet. Publishing is the decision that hands it to
     * every Bot, so it happens after somebody has looked at it rather than the moment it is saved.
     */
    async save(input: {
      slug: string;
      title: string;
      description: string;
      html: string;
      css: string;
      jsFunctions: string;
      argumentSchema: Record<string, unknown>;
      sampleArguments: Record<string, unknown>;
      by: string;
      /**
       * Whose component this is. Required: a playground save with nobody
       * behind it has no sandbox to belong to, and an ownerless save is how
       * one user's code ends up drawn in another user's transcript.
       */
      ownerId: string;
    }): Promise<SandboxedRecord> {
      if (!/^[a-z0-9][a-z0-9_]{0,38}[a-z0-9]$/.test(input.slug)) {
        throw new SandboxedNameRefusedError(
          "A name is lower-case letters, numbers and underscores.",
        );
      }
      const name = sandboxedNameFor(input.slug);

      // A name somebody else owns is taken, not shared: overwriting it would
      // put one user's code in every transcript that draws it. Legacy shared
      // rows (no owner) may be claimed by whoever saves the name first, which
      // stamps them and ends the sharing.
      const [existing] = await database
        .select({ ownerUserId: sandboxedComponents.ownerUserId })
        .from(sandboxedComponents)
        .where(eq(sandboxedComponents.name, name))
        .limit(1);
      if (existing?.ownerUserId && existing.ownerUserId !== input.ownerId) {
        throw new SandboxedNameRefusedError(
          "That name belongs to somebody else's component. Pick another name.",
        );
      }

      await database
        .insert(sandboxedComponents)
        .values({
          name,
          title: input.title,
          draftDescription: input.description,
          draftHtml: input.html,
          draftCss: input.css,
          draftJsFunctions: input.jsFunctions,
          draftArgumentSchema: input.argumentSchema,
          sampleArguments: input.sampleArguments,
          authoredBy: input.by,
          ownerUserId: input.ownerId,
        })
        .onConflictDoUpdate({
          target: sandboxedComponents.name,
          set: {
            title: input.title,
            draftDescription: input.description,
            draftHtml: input.html,
            draftCss: input.css,
            draftJsFunctions: input.jsFunctions,
            draftArgumentSchema: input.argumentSchema,
            sampleArguments: input.sampleArguments,
            authoredBy: input.by,
            ownerUserId: input.ownerId,
            updatedAt: new Date(),
          },
        });

      // The governance row. `published` is left alone on conflict: an administrator publishing a
      // description is their decision, and a save must not quietly undo or advance it.
      await database
        .insert(components)
        .values({
          name,
          title: input.title,
          kind: "sandboxed",
          draftDescription: input.description,
          publishedDescription: null,
          published: false,
          updatedBy: input.by,
        })
        .onConflictDoUpdate({
          target: components.name,
          set: {
            title: input.title,
            draftDescription: input.description,
            updatedBy: input.by,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "component.draft_saved",
        targetType: "component",
        targetId: name,
        payload: { actor: input.by, kind: "sandboxed" },
      });

      return toRecord(await requireRow(name));
    },

    /**
     * Publish: the source and the description, in one act.
     *
     * One button because it is one decision. Publishing the wording without the markup would offer
     * the model a component that draws the previous version, and publishing the markup without the
     * wording would leave a component no model is told about. Either half on its own is a state
     * nobody wants and both would be reachable if this were two endpoints.
     */
    async publish(
      name: string,
      by: string,
      ownerId: string,
    ): Promise<SandboxedRecord> {
      const row = await requireRow(name);
      // Only the author publishes: publishing hands this code to every Bot
      // the author grants it to, and another user's publish would put their
      // decision on somebody else's code. Legacy shared rows are frozen.
      if (!row.ownerUserId || row.ownerUserId !== ownerId) {
        throw new SandboxedNotFoundError(name);
      }

      await database
        .update(sandboxedComponents)
        .set({
          publishedDescription: row.draftDescription,
          publishedHtml: row.draftHtml,
          publishedCss: row.draftCss,
          publishedJsFunctions: row.draftJsFunctions,
          publishedArgumentSchema: row.draftArgumentSchema,
          published: true,
          publishedAt: new Date(),
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(sandboxedComponents.name, name));

      await database
        .update(components)
        .set({
          publishedDescription: row.draftDescription,
          published: true,
          publishedAt: new Date(),
          updatedBy: by,
          updatedAt: new Date(),
        })
        .where(eq(components.name, name));

      await recordAuditEvent(auditStore, {
        eventType: "component.published",
        targetType: "component",
        targetId: name,
        payload: { actor: by, kind: "sandboxed", revision: row.revision + 1 },
      });

      return toRecord(await requireRow(name));
    },

    async remove(name: string, by: string, ownerId: string): Promise<void> {
      // Only the author deletes a live component: the rows below take the
      // published source with them, and another user's delete would unpublish
      // somebody else's code from every transcript that draws it. "Not
      // found" rather than forbidden, so the check cannot become an oracle
      // for other people's component names. A governance orphan (no source
      // row left to own) is still cleared below: it belongs to this surface
      // and nothing else can reach it.
      const row = await requireRow(name).catch(() => null);
      if (row && (!row.ownerUserId || row.ownerUserId !== ownerId)) {
        throw new SandboxedNotFoundError(name);
      }
      /*
       * Refuse a name this surface does not own.
       *
       * `components` is shared with the compiled catalogue and the delete below is by name, with
       * nothing checking which kind of component the name belonged to. So a compiled component's
       * governance row could be deleted through the playground's endpoint, and the foreign keys took
       * its per-Bot withholdings and its function grants with it.
       *
       * The withholdings are the half that fails open. A published component is available to every
       * Bot unless a `component_exclusions` row says otherwise, so losing that row does not hide the
       * component, it releases it — and the next catalogue announcement rewrites the component with
       * `published: true`, because that is how one the build ships arrives. A deliberate "not this
       * Bot" comes back as "every Bot", under an audit row saying `kind: "sandboxed"`, which is the
       * one thing it was not.
       *
       * Asked of the governance row's `kind` rather than of `sandboxed_components`, because ownership
       * is the actual question and the two answers differ in one case worth keeping: these deletes
       * are not in a transaction, so a failure between them leaves a governance row with no source.
       * That orphan is the "catalogue disagrees with the build" state named below, it is this
       * surface's to clean up, and requiring the source row would have made it undeletable here.
       */
      const [governance] = await database
        .select({ kind: components.kind })
        .from(components)
        .where(eq(components.name, name))
        .limit(1);
      // "sandboxed" is the kind `save` writes above. A name with no row at all is refused for the
      // same reason `publish` refuses one: this surface has nothing by that name to act on.
      if (governance?.kind !== "sandboxed") {
        throw new SandboxedNotFoundError(name);
      }

      // Delete both rows; a governance row pointing at a component with no source is the visible
      // "catalogue disagrees with the build" state.
      await database
        .delete(sandboxedComponents)
        .where(eq(sandboxedComponents.name, name));
      await database.delete(components).where(eq(components.name, name));

      await recordAuditEvent(auditStore, {
        eventType: "component.unpublished",
        targetType: "component",
        targetId: name,
        payload: { actor: by, kind: "sandboxed", change: "deleted" },
      });
    },

    /**
     * The published source for every sandboxed component, which is what the app renders from.
     *
     * Published only, and null is not a fallback. A component that has never been published has no
     * published source, so it is absent from this list and the app has nothing to draw. A draft
     * quietly rendering in production is the one outcome the draft column exists to prevent.
     */
    /**
     * The published source this person may draw with: their own components
     * plus legacy shared rows. Nothing of anybody else's: a published page
     * one user wrote is not another user's to render.
     */
    async published(ownerId: string): Promise<PublishedSandboxed[]> {
      const rows = await database
        .select()
        .from(sandboxedComponents)
        .where(
          and(
            eq(sandboxedComponents.published, true),
            or(
              eq(sandboxedComponents.ownerUserId, ownerId),
              isNull(sandboxedComponents.ownerUserId),
            ),
          ),
        );
      return rows
        .filter((row) => row.publishedHtml !== null)
        .map((row) => ({
          name: row.name,
          html: row.publishedHtml ?? "",
          css: row.publishedCss ?? "",
          jsFunctions: row.publishedJsFunctions ?? "",
          argumentSchema: (row.publishedArgumentSchema ?? {}) as Record<
            string,
            unknown
          >,
        }));
    },
  };
}

export type SandboxedStore = ReturnType<typeof createSandboxedStore>;
