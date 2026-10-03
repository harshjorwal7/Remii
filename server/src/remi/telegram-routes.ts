import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { createTelegramClient, createTelegramLinks } from "./telegram";

/**
 * The person's Telegram link, behind sign-in like every other settings surface.
 *
 * - `GET /status` — whether this chat-linked account exists, and the bot to open.
 * - `POST /link` — mint a single-use `/start <token>` code (15 minutes).
 * - `POST /unlink` — drop the link. Messages from the chat go unanswered afterwards.
 *
 * Unmounted (503) without a bot token: the username, the code and the status are all
 * meaningless when there is no bot to link to. The bot username comes from `TELEGRAM_BOT_USERNAME`
 * when set, else from a live `getMe` — a placeholder username is never shown, because a
 * `t.me` link with the wrong name attaches the person's account intent to a stranger's bot.
 */
export function createTelegramRoutes(options: {
  database: Database;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  botToken?: string;
  botUsername?: string;
}) {
  const { database, requireUser } = options;
  const routes = new Hono<{ Variables: AppVariables }>();
  const links = createTelegramLinks(database);

  const username = async (): Promise<string | null> => {
    if (options.botUsername?.trim()) return options.botUsername.trim();
    if (!options.botToken) return null;
    try {
      const me = await createTelegramClient(options.botToken).getMe();
      return me.username ?? null;
    } catch {
      return null;
    }
  };

  routes.get("/status", requireUser, async (context) => {
    if (!options.botToken) {
      return context.json(
        { configured: false, linked: false, botUsername: null },
        503,
      );
    }
    const actor = context.var.actor;
    // Linked state is read off the person's own row, not by scanning chats.
    const linked = await hasLink(database, actor.id);
    return context.json({
      configured: true,
      linked,
      botUsername: await username(),
    });
  });

  routes.post("/link", requireUser, async (context) => {
    if (!options.botToken) {
      return context.json(
        { error: "Telegram is not configured on this deployment." },
        503,
      );
    }
    const actor = context.var.actor;
    const name = await username();
    if (!name) {
      return context.json(
        { error: "The bot username could not be read. Try again in a bit." },
        502,
      );
    }
    const minted = await links.mint(actor.id);
    return context.json({
      code: minted.token,
      link: `https://t.me/${name}?start=${minted.token}`,
      expiresAt: minted.expiresAt.toISOString(),
    });
  });

  routes.post("/unlink", requireUser, async (context) => {
    const actor = context.var.actor;
    await links.unlink(actor.id);
    return context.json({ ok: true });
  });

  return routes;
}

async function hasLink(database: Database, userId: string): Promise<boolean> {
  const { telegramLinks } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await database
    .select({ chatId: telegramLinks.chatId })
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, userId))
    .limit(1);
  return !!rows[0]?.chatId;
}
