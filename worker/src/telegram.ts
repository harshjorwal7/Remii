/**
 * Telegram long-poll, beside the routines loop.
 *
 * `getUpdates` with a 25s server-side wait: one request outstanding, answered when a message
 * lands. Offset advances only past handled updates, so a crash replays at most the in-flight
 * one — and the turn it triggers is idempotent enough (a chat turn) that a rare double-run
 * is a duplicate reply, not corruption. On boot the offset fast-forwards past anything that
 * arrived while nobody was listening, so a restart does not answer a week of backlog.
 */

export type TelegramLoopOptions = {
  botToken: string;
  serverInternalUrl: string;
  workerSharedSecret: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat?: { id?: number };
    text?: string;
    caption?: string;
    voice?: { file_id?: string };
    photo?: { file_id?: string }[];
    document?: { file_id?: string; file_name?: string };
  };
};

async function botCall(
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(40_000),
    },
  );
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

async function deliver(
  options: TelegramLoopOptions,
  message: {
    chatId: string;
    text: string;
    voiceFileId?: string;
    photoFileIds?: string[];
    documentFileId?: string;
    documentName?: string;
  },
): Promise<void> {
  const response = await fetch(
    `${options.serverInternalUrl}/internal/telegram/incoming`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.workerSharedSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(55_000),
    },
  );
  if (response.status !== 200) {
    throw new Error(
      `the server answered ${response.status} for a Telegram message`,
    );
  }
}

export async function runTelegramLoop(
  options: TelegramLoopOptions,
): Promise<never> {
  // Fast-forward past anything that arrived while nobody listened.
  let offset: number | undefined;
  try {
    const pending = (await botCall(options.botToken, "getUpdates", {
      timeout: 0,
    })) as TelegramUpdate[];
    for (const update of pending) {
      offset =
        offset === undefined
          ? update.update_id + 1
          : Math.max(offset, update.update_id + 1);
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "telegram-offset-fast-forward-failed",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  for (;;) {
    let updates: TelegramUpdate[];
    try {
      updates = (await botCall(options.botToken, "getUpdates", {
        ...(offset !== undefined ? { offset } : {}),
        timeout: 25,
        allowed_updates: ["message"],
      })) as TelegramUpdate[];
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "telegram-poll-failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const chatId = update.message?.chat?.id;
      const incoming = update.message;
      const text = incoming?.text ?? incoming?.caption ?? "";
      const voiceFileId = incoming?.voice?.file_id;
      const photoFileIds = (incoming?.photo ?? [])
        .map((photo) => photo.file_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const documentFileId = incoming?.document?.file_id;
      if (chatId === undefined) continue;
      if (
        !text.trim() &&
        !voiceFileId &&
        photoFileIds.length === 0 &&
        !documentFileId
      ) {
        continue;
      }
      if (update.message && "from" in update.message) {
        const from = (update.message as { from?: { is_bot?: boolean } }).from;
        if (from?.is_bot) continue;
      }
      try {
        await deliver(options, {
          chatId: String(chatId),
          text,
          ...(voiceFileId ? { voiceFileId } : {}),
          ...(photoFileIds.length > 0 ? { photoFileIds } : {}),
          ...(documentFileId ? { documentFileId } : {}),
          ...(incoming?.document?.file_name
            ? { documentName: incoming.document.file_name }
            : {}),
        });
      } catch (error) {
        console.warn(
          JSON.stringify({
            type: "telegram-deliver-failed",
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }
}
