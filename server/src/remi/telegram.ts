import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "../db/client";
import { telegramLinks, users } from "../db/schema";

/**
 * Telegram, without a bot framework.
 *
 * Raw HTTPS calls to api.telegram.org (sendMessage/getUpdates) — no grammy, no telegraf, no
 * webhook. The worker long-polls `getUpdates`; the server turns each message into a turn and
 * sends the reply back. Webhooks need a public URL with TLS; polling works behind NAT, which
 * is where this deployment lives.
 *
 * Linking binds a Telegram chat to an Remii person exactly once: the app mints a single-use
 * token (`t.me/<bot>?start=<token>`); `/start <token>` arriving from Telegram consumes it and
 * records the chat id. Every later message from that chat id runs as that person. A chat that
 * never linked gets one sentence telling it how, and nothing else.
 */

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean; username?: string };
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
    voice?: { file_id: string; duration?: number };
    photo?: { file_id: string; width?: number; height?: number }[];
    document?: { file_id: string; file_name?: string; mime_type?: string };
  };
};

const TELEGRAM_API = "https://api.telegram.org";

async function callBotApi(
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) {
    throw new Error(`Telegram ${method} answered ${response.status}.`);
  }
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
  } | null;
  if (!body?.ok) {
    throw new Error(
      `Telegram ${method} refused: ${String(body?.description ?? "unknown").slice(0, 200)}`,
    );
  }
  return body.result;
}

/** Split outgoing text on Telegram's 4096-character message ceiling. */
export function chunkTelegramText(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function createTelegramClient(token: string) {
  return {
    async sendMessage(chatId: number | string, text: string): Promise<void> {
      for (const chunk of chunkTelegramText(text)) {
        await callBotApi(token, "sendMessage", {
          chat_id: chatId,
          text: chunk,
        });
      }
    },

    /**
     * A voice reply: MP3 bytes as a Telegram voice message with the text as its caption.
     * Multipart because Bot API file uploads are not JSON; failures stay with the caller,
     * which falls back to text — a turn that answered must not fail over audio.
     */
    async sendVoice(
      chatId: number | string,
      audio: Uint8Array,
      caption: string,
    ): Promise<void> {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append(
        "voice",
        new Blob([audio.buffer as ArrayBuffer], { type: "audio/mpeg" }),
        "reply.mp3",
      );
      if (caption.trim()) {
        form.append("caption", caption.slice(0, 1024));
      }
      const response = await fetch(`${TELEGRAM_API}/bot${token}/sendVoice`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      }).catch(() => null);
      if (!response?.ok) {
        const body = await response?.json().catch(() => null);
        throw new Error(
          `Telegram sendVoice refused: ${String((body as { description?: unknown } | null)?.description ?? response?.status ?? "unknown").slice(0, 200)}`,
        );
      }
    },

    async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
      const result = (await callBotApi(token, "getUpdates", {
        ...(offset !== undefined ? { offset } : {}),
        timeout: 25,
        allowed_updates: ["message"],
      })) as TelegramUpdate[];
      return Array.isArray(result) ? result : [];
    },

    async getMe(): Promise<{ username?: string }> {
      const me = (await callBotApi(token, "getMe", {})) as {
        username?: string;
      };
      return { username: me.username };
    },

    /** Resolve a Telegram file_id to downloadable bytes, capped at 30 MB like Remi. */
    async downloadFile(
      fileId: string,
    ): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
      const file = (await callBotApi(token, "getFile", {
        file_id: fileId,
      }).catch(() => null)) as { file_path?: string } | null;
      if (!file?.file_path) return null;
      const response = await fetch(
        `${TELEGRAM_API}/file/bot${token}/${file.file_path}`,
        { signal: AbortSignal.timeout(60_000) },
      ).catch(() => null);
      if (!response?.ok) return null;
      const buffer = await response.arrayBuffer().catch(() => null);
      if (
        !buffer ||
        buffer.byteLength === 0 ||
        buffer.byteLength > 30_000_000
      ) {
        return null;
      }
      const extension = file.file_path.split(".").pop()?.toLowerCase() ?? "";
      const mimeType =
        extension === "ogg" || extension === "oga"
          ? "audio/ogg"
          : extension === "mp3"
            ? "audio/mp3"
            : extension === "jpg" || extension === "jpeg"
              ? "image/jpeg"
              : extension === "png"
                ? "image/png"
                : extension === "pdf"
                  ? "application/pdf"
                  : "application/octet-stream";
      return { bytes: new Uint8Array(buffer), mimeType };
    },
  };
}

export type TelegramClient = ReturnType<typeof createTelegramClient>;

export function createTelegramLinks(database: Database) {
  return {
    /** Mint a single-use linking token for this person (15 minutes). */
    async mint(userId: string): Promise<{ token: string; expiresAt: Date }> {
      const token = randomUUID().replace(/-/g, "").slice(0, 24);
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await database
        .insert(telegramLinks)
        .values({ userId, linkToken: token, linkTokenExpiresAt: expiresAt })
        .onConflictDoUpdate({
          target: [telegramLinks.userId],
          set: { linkToken: token, linkTokenExpiresAt: expiresAt },
        });
      return { token, expiresAt };
    },

    /** Consume a linking token presented as `/start <token>` from a chat. */
    async consume(
      token: string,
      chatId: string,
    ): Promise<{ userId: string } | null> {
      const rows = await database
        .select({ userId: telegramLinks.userId })
        .from(telegramLinks)
        .where(
          and(
            eq(telegramLinks.linkToken, token),
            gt(telegramLinks.linkTokenExpiresAt, new Date()),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      await database
        .update(telegramLinks)
        .set({ chatId, linkToken: null, linkTokenExpiresAt: null })
        .where(eq(telegramLinks.userId, row.userId));
      return { userId: row.userId };
    },

    /** Who owns this chat, if it was ever linked. */
    async ownerOf(chatId: string): Promise<{ userId: string } | null> {
      const rows = await database
        .select({ userId: telegramLinks.userId })
        .from(telegramLinks)
        .where(eq(telegramLinks.chatId, chatId))
        .limit(1);
      return rows[0] ?? null;
    },

    async unlink(userId: string): Promise<void> {
      await database
        .delete(telegramLinks)
        .where(eq(telegramLinks.userId, userId));
    },

    async userExists(userId: string): Promise<boolean> {
      const rows = await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows.length > 0;
    },
  };
}

export type TelegramLinks = ReturnType<typeof createTelegramLinks>;

/** `/start <token>` text, split into command and argument. */
export function parseStartCommand(text: string): string | null {
  const match = text.trim().match(/^\/start\s+(\S+)\s*$/);
  return match?.[1] ?? null;
}

/**
 * Voice and media understanding, ported from Remi.
 *
 * Remi transcribes Telegram voice with Gemini and describes images the same way; documents
 * ride as their caption plus a note. Everything is key-gated on `GEMINI_API_KEY`: without
 * it the turn says what is missing rather than failing, because a deployment without media
 * understanding still answers text.
 */

function geminiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || null;
}

async function geminiGenerateContent(
  parts: unknown[],
  model = "gemini-3.1-flash-lite",
): Promise<string | null> {
  const key = geminiKey();
  if (!key) return null;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts }] }),
      signal: AbortSignal.timeout(60_000),
    },
  ).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  } | null;
  const text = body?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  return text || null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Verbatim transcription of a voice note, or null when unavailable. */
export async function transcribeVoice(
  bytes: Uint8Array,
  mimeType: string,
): Promise<string | null> {
  if (!geminiKey()) return null;
  return geminiGenerateContent([
    { text: "Transcribe this voice note verbatim, in its original language." },
    { inline_data: { mime_type: mimeType, data: toBase64(bytes) } },
  ]);
}

/** What a photo shows, or null when unavailable. */
export async function describeImage(
  bytes: Uint8Array,
  mimeType: string,
): Promise<string | null> {
  if (!geminiKey()) return null;
  return geminiGenerateContent([
    { text: "Describe what this image shows, briefly and factually." },
    { inline_data: { mime_type: mimeType, data: toBase64(bytes) } },
  ]);
}

/** Whether this deployment understands voice and images at all. */
export function mediaUnderstandingAvailable(): boolean {
  return geminiKey() !== null;
}
