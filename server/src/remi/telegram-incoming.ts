import { REMII_AGENT_ID } from "../../../shared/remii";
import type { AgentActor } from "../agents/profile-types";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import type { TurnRunner } from "../routines/runner";
import {
  createTelegramClient,
  createTelegramLinks,
  describeImage,
  mediaUnderstandingAvailable,
  parseStartCommand,
  transcribeVoice,
} from "./telegram";
import { synthesizeSpeech, voiceConfig } from "./voice";

/**
 * One Telegram message in, one turn out.
 *
 * `/start <token>` consumes a linking token minted by the app and binds the chat; anything
 * else from an unlinked chat gets the one sentence that explains linking and nothing else.
 * A linked chat runs a turn as its owner in their 1:1 channel with the Bot, and the reply
 * goes back over Telegram as well as landing in the channel. Never throws: the worker loop
 * must not die on one bad message.
 *
 * Voice notes transcribe and photos describe through Gemini when `GEMINI_API_KEY` is set;
 * without it they say what is missing. Documents ride as their caption. A per-chat rate
 * bucket (twenty turns a minute) stops a looped client or a pasted firehose from spending
 * the deployment's model budget in one go; over it the chat gets one sentence, not silence.
 */
export type TelegramIncomingMessage = {
  chatId: string;
  text: string;
  voiceFileId?: string;
  photoFileIds?: string[];
  documentFileId?: string;
  documentName?: string;
};

export type TelegramIncomingDeps = {
  database: Database;
  channelStore: ChannelStore;
  runTurn: TurnRunner;
  botToken: string;
  defaultBotId?: string;
};

const RATE_LIMIT_PER_MINUTE = 20;

/** A per-chat turn bucket, extracted so tests can drive it without a database. */
export function createRateLimiter(
  limitPerMinute: number = RATE_LIMIT_PER_MINUTE,
) {
  const recent = new Map<string, number[]>();
  return {
    take(chatId: string): boolean {
      const now = Date.now();
      const windowStart = now - 60_000;
      const stamps = (recent.get(chatId) ?? []).filter(
        (stamp) => stamp > windowStart,
      );
      if (stamps.length >= limitPerMinute) {
        recent.set(chatId, stamps);
        return false;
      }
      stamps.push(now);
      recent.set(chatId, stamps);
      return true;
    },
  };
}

const limiter = createRateLimiter();

/**
 * What a Telegram message says, once media becomes words.
 *
 * Exported for tests: the client is the only seam, so a fake download exercises every
 * branch without the network. Voice transcribes, the largest photo describes, documents
 * ride as their caption plus a note — and anything missing a key or a download says what
 * is missing instead of failing the turn.
 */
export async function resolveIncomingText(
  client: ReturnType<typeof createTelegramClient>,
  message: TelegramIncomingMessage,
): Promise<string> {
  const caption = message.text.trim();
  // Documents are never downloaded: without a parser the bytes buy nothing, so they ride
  // as their caption plus a note naming the file.
  if (
    message.documentFileId &&
    !message.voiceFileId &&
    !message.photoFileIds?.length
  ) {
    const name = message.documentName?.trim();
    return caption
      ? `${caption}\n\n[Attached file${name ? `: ${name}` : ""}]`
      : `[Attached file${name ? `: ${name}` : ""} with no caption]`;
  }
  const media = message.voiceFileId ?? message.photoFileIds?.[0];
  if (!media) return caption;

  const downloaded = await client.downloadFile(media).catch(() => null);
  if (!downloaded) {
    return caption || "A file arrived that could not be downloaded.";
  }
  if (!mediaUnderstandingAvailable()) {
    // The caption still travels: the turn reads what the person wrote, and the note says the
    // media itself went unread, rather than the turn failing over an attachment.
    const note =
      "A voice note or photo arrived, but this deployment has no media understanding configured.";
    return caption ? `${caption}\n\n[${note}]` : note;
  }
  if (message.voiceFileId) {
    const transcript = await transcribeVoice(
      downloaded.bytes,
      downloaded.mimeType,
    ).catch(() => null);
    if (!transcript)
      return caption || "A voice note arrived that could not be transcribed.";
    return caption
      ? `${caption}\n\nVoice note says: ${transcript}`
      : transcript;
  }
  if (message.photoFileIds?.length) {
    const seen = await describeImage(
      downloaded.bytes,
      downloaded.mimeType,
    ).catch(() => null);
    if (!seen) return caption || "A photo arrived that could not be read.";
    return caption
      ? `${caption}\n\nPhoto shows: ${seen}`
      : `Photo shows: ${seen}`;
  }
  return caption || "A file arrived that could not be read.";
}

export async function handleTelegramIncoming(
  deps: TelegramIncomingDeps,
  message: TelegramIncomingMessage,
): Promise<{ replied: boolean }> {
  const { database, channelStore, runTurn, botToken } = deps;
  const botId = deps.defaultBotId ?? REMII_AGENT_ID;
  const links = createTelegramLinks(database);
  const client = createTelegramClient(botToken);
  const text = await resolveIncomingText(client, message);
  if (!text) return { replied: false };

  if (!limiter.take(message.chatId)) {
    await client
      .sendMessage(
        message.chatId,
        "Slow down a little — one message at a time.",
      )
      .catch(() => undefined);
    return { replied: false };
  }

  const linkToken = parseStartCommand(text);
  if (linkToken) {
    const bound = await links
      .consume(linkToken, message.chatId)
      .catch(() => null);
    await client
      .sendMessage(
        message.chatId,
        bound
          ? "Linked. Messages here now run as you — say anything."
          : "That link has expired or was already used. Mint a fresh one from Settings and send /start with it.",
      )
      .catch(() => undefined);
    return { replied: true };
  }

  const owner = await links.ownerOf(message.chatId).catch(() => null);
  if (!owner) {
    await client
      .sendMessage(
        message.chatId,
        "This chat is not linked to anybody yet. Link it from the app's settings first: open your Bot, ask for a Telegram link, and send me /start with the token.",
      )
      .catch(() => undefined);
    return { replied: false };
  }

  try {
    const actor: AgentActor = { id: owner.userId, role: "user" };
    const channel = await channelStore.direct(actor, botId);
    const result = await runTurn({
      ownerUserId: owner.userId,
      routineId: `telegram:${message.chatId}`,
      agentId: botId,
      threadId: channel.threadId,
      instruction: text,
    });
    try {
      await channelStore.recordActivity(actor, channel.id, {
        text: result.replyText,
        agentId: botId,
        at: new Date(),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "telegram-activity-unrecorded",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    /*
     * A voice note earns a voice reply when the deployment can speak: the spoken answer
     * carries the same words as its caption, so one message does both jobs. Text that will
     * not synthesize, and every text message, goes out as text. Audio failures fall back to
     * text rather than failing a turn that already answered.
     */
    if (message.voiceFileId && voiceConfig()) {
      const audio = await synthesizeSpeech(result.replyText).catch(() => null);
      if (audio) {
        const spoken = await client
          .sendVoice(message.chatId, audio, result.replyText)
          .then(() => true)
          .catch(() => false);
        if (spoken) return { replied: true };
      }
    }
    await client.sendMessage(message.chatId, result.replyText);
    return { replied: true };
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "telegram-turn-failed",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    await client
      .sendMessage(
        message.chatId,
        "That failed on my side. Try again in a bit.",
      )
      .catch(() => undefined);
    return { replied: false };
  }
}
