import { sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  ACCEPTED_AUDIO_MIME,
  ACCEPTED_IMAGE_MIME,
  ACCEPTED_TEXT_MIME,
  ACCEPTED_VIDEO_MIME,
  classifyAttachment,
  maxBytesForKind,
  mediaTypeOf,
} from "../../../shared/attachments";
import type { AppVariables } from "../auth/guards";
import { sniffMimeType } from "../channels/attachment-mime";
import { contentDispositionFilename } from "../channels/attachments";
import type { Database } from "../db/client";
import { toolResultText } from "../plugins/tools";
import { nextOccurrence } from "../routines/schedule";
import {
  artifactStorageKey,
  type BlobRange,
  type BlobStore,
} from "../storage/blob-store";
import { createRemiInstanceStore, InvalidInstanceModelError } from "./instance";
import { createRemiStore } from "./store";
import { synthesizeSpeech, voiceConfig } from "./voice";

/**
 * The Bot's memory, files, tasks and schedules, behind sign-in like every settings surface.
 *
 * What the settings screens read and write. The agent reaches the same rows through its tools;
 * these routes are the person's own view of that shared state. No grant checks: a person sees
 * all of their own rows here, while a Bot only ever sees what a run offers it.
 */
/**
 * The artifact types a browser renders as themselves, and which are therefore served inline.
 *
 * Read from the shared lists rather than written out again, so a type added there is served the same
 * way here. Deliberately excludes documents: an artifact PDF is a model-authored document that the
 * Files page draws itself, and handing the browser a viewer for it is not something this app can
 * sandbox from an origin it also serves chat on.
 */
/**
 * The text an uploaded file contributes, or null when it has none.
 *
 * Only the text kinds are read. A PDF's text is worth having — a person who uploaded a contract
 * expects to be able to search it — but the extraction is bounded by the shared character ceiling
 * and by the extractor's own patience, and this route is answering "did it save" rather than
 * "what is in it". Anything that is not text stores without it, and the Files page says so rather
 * than showing an empty box that looks broken.
 */
function textOnly(mimeType: string, bytes: Uint8Array): string | null {
  if (classifyAttachment(mimeType) !== "text") return null;
  return new TextDecoder().decode(bytes).slice(0, 200_000);
}

const INLINE_ARTIFACT_MIME: ReadonlySet<string> = new Set<string>([
  ...ACCEPTED_IMAGE_MIME,
  ...ACCEPTED_TEXT_MIME,
  ...ACCEPTED_AUDIO_MIME,
  ...ACCEPTED_VIDEO_MIME,
]);

export function createRemiRoutes(options: {
  database: Database;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /**
   * Where a saved file's bytes are. Absent in tests, and then the content route answers 503 rather
   * than pretending a file is missing — see the note on that route.
   */
  blobs?: BlobStore;
}) {
  const { database, requireUser } = options;
  const blobs = (): BlobStore | undefined => options.blobs;
  const routes = new Hono<{ Variables: AppVariables }>();
  const store = () =>
    createRemiStore({
      database,
      ...(options.blobs ? { blobs: options.blobs } : {}),
      ...(process.env.EMBEDDINGS_API_KEY
        ? {
            embeddingsApiKey: process.env.EMBEDDINGS_API_KEY,
            ...(process.env.EMBEDDINGS_BASE_URL
              ? { embeddingsBaseUrl: process.env.EMBEDDINGS_BASE_URL }
              : {}),
          }
        : {}),
    });
  const me = (context: { var: { actor: { id: string } } }) =>
    context.var.actor.id;

  /**
   * Whether a stored file's type is one a browser renders as itself.
   *
   * The same four the attachment route serves inline, and for the same reason: each one's media type
   * was decided by the sniffer, so the header is one this server stands behind. Everything else
   * downloads, including a PDF — an artifact PDF is a model-authored document rather than a message
   * attachment, and the Files page draws it in the page rather than handing the browser a viewer it
   * cannot sandbox.
   */
  const inlineFor = (mimeType: string | null): boolean =>
    INLINE_ARTIFACT_MIME.has(mediaTypeOf(mimeType ?? ""));

  /**
   * One `Range` header against a file whose length the row may not even know.
   *
   * A null size is the interesting case: a row written before `size` was recorded, or by something
   * that never measured. A range cannot be validated against a length that is not known, so the range
   * is passed through and the DRIVER clamps it against the real length — which is the only place
   * that has one.
   */
  const parseArtifactRange = (
    header: string | undefined,
    size: number | null,
  ): { start: number; endExclusive: number } | null => {
    if (!header) return null;
    const match = /^bytes=(\d+)-(\d*)$/i.exec(header.trim());
    if (!match) return null;
    const start = Number.parseInt(match[1] ?? "0", 10);
    const endText = match[2] ?? "";
    if (size !== null && start >= size) return null;
    const endExclusive =
      endText === ""
        ? Number.MAX_SAFE_INTEGER
        : Math.max(start + 1, Number.parseInt(endText, 10) + 1);
    return { start, endExclusive };
  };

  routes.get("/memories", requireUser, async (context) => {
    const rows = await store().listMemories({
      userId: me(context),
      limit: 100,
    });
    return context.json({ memories: rows });
  });

  routes.get("/memories/search", requireUser, async (context) => {
    const query = context.req.query("q") ?? "";
    if (!query.trim()) return context.json({ memories: [] });
    const result = await store()
      .searchMemories({
        userId: me(context),
        query: query.slice(0, 500),
        limit: 20,
      })
      .catch(() => ({ found: false, memories: [] }));
    return context.json({ memories: result.memories });
  });

  routes.patch("/memories/:id", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      content?: unknown;
      pinned?: unknown;
    } | null;
    const patch: { content?: string; pinned?: boolean } = {};
    if (typeof body?.content === "string" && body.content.trim()) {
      // Correcting a memory re-embeds it below, so recall follows the fix.
      patch.content = body.content.trim().slice(0, 8000);
    }
    if (typeof body?.pinned === "boolean") patch.pinned = body.pinned;
    if (Object.keys(patch).length === 0) {
      return context.json({ error: "Nothing to change." }, 400);
    }
    const ok = await store().updateMemory(
      context.req.param("id"),
      me(context),
      patch,
    );
    return context.json({ ok }, ok ? 200 : 404);
  });

  routes.get("/memories/stats", requireUser, async (context) => {
    const userId = me(context);
    const [counts, events] = await Promise.all([
      database
        .execute(
          sql`SELECT scope, COUNT(*)::int AS count FROM memories WHERE user_id = ${userId} AND deleted_at IS NULL AND superseded_by IS NULL GROUP BY scope`,
        )
        .catch(() => []),
      database
        .execute(
          sql`SELECT kind, COUNT(*)::int AS count FROM memory_events WHERE user_id = ${userId} AND created_at > now() - interval '30 days' GROUP BY kind`,
        )
        .catch(() => []),
    ]);
    return context.json({
      scopes: counts as Array<{ scope: string; count: number }>,
      events: events as Array<{ kind: string; count: number }>,
    });
  });

  routes.delete("/memories/:id", requireUser, async (context) => {
    const ok = await store().deleteMemory(context.req.param("id"), me(context));
    return context.json({ ok }, ok ? 200 : 404);
  });

  routes.get("/artifacts", requireUser, async (context) => {
    const rows = await store().artifacts.list(me(context), 100);
    return context.json({ artifacts: rows });
  });

  routes.get("/artifacts/:id", requireUser, async (context) => {
    const row = await store().artifacts.byIdOrName(
      me(context),
      context.req.param("id"),
    );
    if (!row) return context.json({ error: "No such file." }, 404);
    return context.json({
      artifact: {
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        content: (row.extractedText ?? "").slice(0, 100_000),
      },
    });
  });

  /*
   * THE BYTES THEMSELVES, which `/artifacts/:id` above deliberately does not send.
   *
   * That route answers with the extracted text, because a model wrote the text and a person reading
   * a note wants the note. It cannot answer a preview: an image has no extracted text, a PDF's
   * extraction is lossy, and a `.zip` has none at all. So this is the other half — the same row,
   * the same owner check, and the bytes as a body.
   *
   * WHY IT IS PROXIED RATHER THAN A LINK. A `url` on the row that pointed at a bucket would hand the
   * bytes to the browser and take this process out of the loop, which is cheaper — and which would
   * also mean anyone holding that link could read the file for as long as it lived, with no check
   * that they were ever a member of the channel it belongs to. This app re-decides access on every
   * fetch, and this route is where it does it. See the note on `createS3BlobStore`.
   */
  routes.get("/artifacts/:id/content", requireUser, async (context) => {
    const actorId = me(context);
    const row = await store().artifacts.byIdOrName(
      actorId,
      context.req.param("id"),
    );
    if (!row) return context.json({ error: "No such file." }, 404);

    const blobStore = blobs();
    if (!blobStore) {
      return context.json(
        { error: "This deployment has no file storage configured." },
        503,
      );
    }

    let slice: { bytes: Uint8Array; totalBytes: number };
    let range: BlobRange | null = null;
    try {
      /*
       * A RANGE, IF ONE WAS ASKED FOR. Reached through the driver rather than sliced here, because
       * on the S3 driver a range is a `Range` header and a local `subarray` of a file this process
       * never read would be a lie about where the bytes came from. The driver returns the total as
       * well, which is what a media element builds its seek bar from.
       */
      range = parseArtifactRange(context.req.header("Range"), row.size);
      slice = range
        ? await blobStore.getRange(row.storageKey as string, range)
        : await blobStore.get(row.storageKey as string);
    } catch {
      /*
       * A ROW WHOSE BYTES ARE GONE IS NOT A 404.
       *
       * The row exists and belongs to this person, so "no such file" would be a lie they would act
       * on — they would assume they had deleted it, or never had it. The truth is that the metadata
       * is here and the file is not, which is a storage fault and worth saying so.
       */
      return context.json(
        { error: "This file's contents are no longer available." },
        410,
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": row.mimeType ?? "application/octet-stream",
      /*
       * NEVER THE ROW'S OWN NAME UNCHECKED. This is a `Content-Disposition` built from something a
       * model chose, on a response a browser may act on; `contentDispositionFilename` is the same
       * escaper the attachment route uses and the reason is the same.
       */
      "Content-Disposition": `${inlineFor(row.mimeType) ? "inline" : "attachment"}; ${contentDispositionFilename(row.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Length": String(slice.bytes.byteLength),
      "Cache-Control": "private, no-cache",
    };
    if (range) {
      headers["Content-Range"] =
        `bytes ${range.start}-${range.endExclusive - 1}/${slice.totalBytes}`;
    }
    // A `Uint8Array` over a pooled `ArrayBuffer` is a `Uint8Array<ArrayBufferLike>`, and hono's
    // body overloads want a non-shared one. The cast is the same type-level narrowing the
    // attachment route makes, for the same reason: a database or filesystem read does not allocate
    // a `SharedArrayBuffer`, and there is no run-time conversion standing in for the compile-time
    // one.
    return context.body(
      slice.bytes as Uint8Array<ArrayBuffer>,
      range ? 206 : 200,
      headers,
    );
  });

  /*
   * A FILE THE PERSON UPLOADED, RATHER THAN ONE A BOT WROTE.
   *
   * `artifact_create` is a model's tool and its input is text it composed. This is the other door:
   * a person picks a file off their own disk, and the file is stored whole with whatever bytes it
   * has. It exists because the Files page is where somebody goes to find a thing they were sent,
   * and a page that can only show what a model decided to save is a page that cannot hold their own
   * documents.
   *
   * IT IS THE UPLOAD ROUTE'S DOOR AGAIN, NOT A NEW ONE. `sniffMimeType` decides the type from the
   * bytes and `classifyAttachment` decides whether that type is accepted, and neither is told
   * whether the bytes came from a form or a tool — so a file that would be refused as a message
   * attachment is refused here too, with the same reason. A second set of rules for the same bytes
   * would be a way around the first.
   */
  routes.post("/artifacts", requireUser, async (context) => {
    const actorId = me(context);
    const blobStore = blobs();
    if (!blobStore) {
      return context.json(
        { error: "This deployment has no file storage configured." },
        503,
      );
    }

    let form: FormData;
    try {
      form = await context.req.formData();
    } catch {
      return context.json({ error: "That upload could not be read." }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return context.json({ error: "No file was sent." }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const claimed = typeof file.type === "string" ? file.type : "";
    // THE BYTES DECIDE, AND THE CLAIM IS ONLY A TIE-BREAK. See `sniffMimeType`.
    const mimeType = sniffMimeType(bytes, claimed);
    if (
      classifyAttachment(mimeType) === "unsupported" ||
      classifyAttachment(mimeType) === "unsupported-image"
    ) {
      return context.json(
        {
          error: `'${file.name}' is not a file type this app can read (${mimeType}).`,
        },
        415,
      );
    }
    const kind = classifyAttachment(mimeType);
    const limit = maxBytesForKind(kind);
    if (bytes.byteLength > limit) {
      return context.json(
        {
          error: `'${file.name}' is too large for this kind of file (limit ${limit} bytes).`,
        },
        413,
      );
    }

    /*
     * THE ROW BEFORE THE BYTES, AGAIN, FOR THE SAME REASON AS `artifact_create`.
     *
     * A failure between the two leaves a row with no bytes, which the Files page shows as a file
     * that will not open — visible, and cleanable. The other order leaves bytes nothing points at,
     * and `BlobStore` has no `list` to find them with.
     */
    const name = file.name.slice(0, 200) || "upload";
    const id = await store().artifacts.create({
      userId: actorId,
      name,
      url: "",
      mimeType,
      size: bytes.byteLength,
      extractedText: textOnly(mimeType, bytes),
      source: "upload",
    });
    if (!id)
      return context.json({ error: "That file could not be saved." }, 500);

    const key = artifactStorageKey(id, name);
    await blobStore.put(key, bytes, mimeType);
    await store().artifacts.setStorageKey(actorId, id, key);
    return context.json(
      { artifact: { id, name, mimeType, size: bytes.byteLength } },
      201,
    );
  });

  routes.delete("/artifacts/:id", requireUser, async (context) => {
    const ok = await store().artifacts.remove(
      me(context),
      context.req.param("id"),
    );
    return context.json({ ok }, ok ? 200 : 404);
  });

  routes.get("/tasks", requireUser, async (context) => {
    const rows = await store().todos.list({ userId: me(context), limit: 100 });
    return context.json({ tasks: rows });
  });

  routes.post("/tasks", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      title?: unknown;
      importance?: "HIGH" | "MEDIUM" | "LOW";
    } | null;
    if (typeof body?.title !== "string" || !body.title.trim()) {
      return context.json({ error: "A title is required." }, 400);
    }
    const id = await store().todos.add({
      userId: me(context),
      title: body.title.trim().slice(0, 500),
      sourceRef: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      importance: body.importance ?? "MEDIUM",
      createdVia: "MANUAL",
    });
    return context.json({ id }, 201);
  });

  routes.post("/tasks/:id", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      status?: "OPEN" | "IN_PROGRESS" | "NEEDS_REVIEW" | "DONE" | "DISMISSED";
      resultSummary?: string;
    } | null;
    const ok = await store().todos.update(
      me(context),
      context.req.param("id"),
      {
        ...(body?.status ? { status: body.status } : {}),
        ...(typeof body?.resultSummary === "string"
          ? { resultSummary: body.resultSummary.slice(0, 2000) }
          : {}),
      },
    );
    return context.json({ ok }, ok ? 200 : 404);
  });

  routes.delete("/tasks/:id", requireUser, async (context) => {
    const ok = await store().todos.remove(me(context), context.req.param("id"));
    return context.json({ ok }, ok ? 200 : 404);
  });

  routes.get("/schedules", requireUser, async (context) => {
    const rows = await store().cron.list(me(context));
    return context.json({
      schedules: rows.map((row) => ({
        id: row.id,
        botId: row.botId ?? null,
        name: row.name,
        expression: row.expression,
        timezone: row.timezone,
        enabled: row.enabled,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        lastError: row.lastError,
        failures: row.failures ?? 0,
        prompt:
          typeof (row.triggerConfig as { prompt?: unknown } | null)?.prompt ===
          "string"
            ? (row.triggerConfig as { prompt: string }).prompt
            : null,
      })),
    });
  });

  routes.post("/schedules", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      name?: unknown;
      expression?: unknown;
      timezone?: unknown;
      prompt?: unknown;
      botId?: unknown;
    } | null;
    if (
      typeof body?.name !== "string" ||
      !body.name.trim() ||
      typeof body?.expression !== "string" ||
      !body.expression.trim() ||
      typeof body?.prompt !== "string" ||
      !body.prompt.trim()
    ) {
      return context.json(
        { error: "A name, a cron expression and a prompt are required." },
        400,
      );
    }
    let next: Date;
    try {
      next = nextOccurrence(
        body.expression.trim(),
        typeof body.timezone === "string" && body.timezone
          ? body.timezone
          : "UTC",
        new Date(),
      );
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : `That is not a valid cron expression: ${body.expression}`,
        },
        400,
      );
    }
    const existing = await store().cron.list(me(context));
    if (existing.filter((row) => row.enabled).length >= 20) {
      return context.json(
        { error: "You can have at most 20 enabled schedules." },
        400,
      );
    }
    if (body.prompt.length > 4000) {
      return context.json(
        { error: "A schedule prompt can be at most 4000 characters." },
        400,
      );
    }
    const id = await store().cron.create({
      userId: me(context),
      botId:
        typeof body.botId === "string" && body.botId.trim()
          ? body.botId.trim()
          : undefined,
      name: body.name.trim().slice(0, 200),
      expression: body.expression.trim(),
      timezone:
        typeof body.timezone === "string" && body.timezone
          ? body.timezone
          : "UTC",
      triggerConfig: { prompt: body.prompt },
      nextRunAt: next,
    });
    return context.json({ id }, 201);
  });

  routes.post("/schedules/:id", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      enabled?: unknown;
      name?: unknown;
    } | null;
    const patch: {
      enabled?: boolean;
      name?: string;
      nextRunAt?: Date;
    } = {};
    if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body?.name === "string" && body.name.trim()) {
      patch.name = body.name.trim().slice(0, 200);
    }
    if (Object.keys(patch).length === 0) {
      return context.json({ error: "Nothing to change." }, 400);
    }
    if (body?.enabled === true) {
      const current = (await store().cron.list(me(context))).find(
        (row) => row.id === context.req.param("id"),
      );
      if (current) {
        try {
          patch.nextRunAt = nextOccurrence(
            current.expression,
            current.timezone,
            new Date(),
          );
        } catch (error) {
          return context.json(
            {
              error:
                error instanceof Error ? error.message : "Invalid schedule.",
            },
            400,
          );
        }
      }
    }
    const ok = await store().cron.update(
      me(context),
      context.req.param("id"),
      patch,
    );
    return context.json({ ok }, ok ? 200 : 404);
  });

  routes.delete("/schedules/:id", requireUser, async (context) => {
    const ok = await store().cron.remove(me(context), context.req.param("id"));
    return context.json({ ok }, ok ? 200 : 404);
  });

  /*
   * One person's Remi instance: which model their turns answer on. Nulls inherit the
   * deployment default, and clearing back to nulls deletes the row — absence is the only
   * representation of "default", so a screen never has to tell "unset" from "empty".
   */
  routes.get("/instance", requireUser, async (context) => {
    const instances = createRemiInstanceStore(database);
    return context.json({ instance: await instances.read(me(context)) });
  });
  routes.put("/instance", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => undefined)) as
      | { modelSlug?: unknown; modelProvider?: unknown }
      | undefined;
    if (
      (body?.modelSlug !== undefined &&
        body?.modelSlug !== null &&
        typeof body?.modelSlug !== "string") ||
      (body?.modelProvider !== undefined &&
        body?.modelProvider !== null &&
        typeof body?.modelProvider !== "string")
    ) {
      return context.json(
        { error: "Send a model slug and provider, or empty to inherit." },
        400,
      );
    }
    const instances = createRemiInstanceStore(database);
    try {
      const instance = await instances.write(me(context), {
        ...(body?.modelSlug !== undefined
          ? { modelSlug: body.modelSlug as string | null }
          : {}),
        ...(body?.modelProvider !== undefined
          ? {
              modelProvider: body.modelProvider as
                | "openai"
                | "abliteration"
                | null,
            }
          : {}),
      });
      return context.json({ instance });
    } catch (error) {
      if (error instanceof InvalidInstanceModelError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  /*
   * Voice and Google status, as one status screen reads it.
   *
   * Two facts, each cheap to answer: whether spoken replies are configured (ElevenLabs key
   * plus voice), and whether this machine holds the `gog` CLI and an authenticated Google
   * account. Keys are never projected — configured-or-not is what a screen needs, and the
   * values stay in the environment where they belong.
   */
  routes.get("/voice-screen", requireUser, async (context) => {
    void context;
    const voice = voiceConfig();
    const { resolveGogBinary } = await import("./gog");
    const binary = resolveGogBinary();
    let gogAuth: string | null = null;
    if (binary) {
      const { gogToolsFor } = await import("./gog");
      const status = gogToolsFor({ binary }).find(
        (tool) => tool.name === "gog_status",
      );
      if (status) {
        /*
         * `toolResultText`, because this value goes into a JSON response a browser draws, and the
         * widened tool result can be a picture. `gog_status` returns text; the narrowing is here so
         * a future picture-returning tool on this path fails to typecheck rather than serialising
         * `{text, images}` into a field the page renders as a string.
         */
        gogAuth = await status
          .execute({})
          .then(toolResultText)
          .catch(() => "Google CLI status could not be read.");
      }
    }
    return context.json({
      voice: {
        configured: voice !== null,
        voiceId: voice?.voiceId ?? null,
        model: voice?.model ?? null,
      },
      gog: { binary, auth: gogAuth },
    });
  });

  /*
   * Speak a line through the configured voice and report the bytes, without storing audio
   * anywhere. The screen plays nothing itself; it proves the voice works before a Telegram
   * voice note spends real words on it.
   */
  routes.post("/voice-screen/test-speak", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => undefined)) as
      | { text?: unknown }
      | undefined;
    const text =
      typeof body?.text === "string" && body.text.trim()
        ? body.text.trim().slice(0, 300)
        : "Hello from Remii. Your voice replies are working.";
    const audio = await synthesizeSpeech(text);
    if (!audio) {
      return context.json(
        { error: "Voice is not configured, or synthesis failed." },
        503,
      );
    }
    return context.json({ bytes: audio.byteLength });
  });

  return routes;
}
