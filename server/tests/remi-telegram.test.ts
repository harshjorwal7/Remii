import { describe, expect, test } from "bun:test";
import {
  createRateLimiter,
  resolveIncomingText,
} from "../src/remi/telegram-incoming";
import { mediaUnderstandingAvailable } from "../src/remi/telegram";

/**
 * Telegram media resolution and rate limiting, minus the network.
 *
 * The download client is a fake; transcription needs a Gemini key this environment does
 * not have, which is exactly the branch that says what is missing. What pins the
 * contract: media becomes words before any turn runs, nothing missing ever fails the
 * turn, and a firehose gets one sentence rather than twenty turns.
 */

const GEMINI_KEY = process.env.GEMINI_API_KEY;

function clientWith(
  download: () => Promise<{ bytes: Uint8Array; mimeType: string } | null>,
) {
  return { downloadFile: download } as never;
}

describe("resolveIncomingText", () => {
  test("plain text passes through untouched", async () => {
    const text = await resolveIncomingText(
      clientWith(async () => null),
      {
        chatId: "c",
        text: "hello there",
      },
    );

    expect(text).toBe("hello there");
  });

  test("an undownloadable file names the failure", async () => {
    const text = await resolveIncomingText(
      clientWith(async () => null),
      {
        chatId: "c",
        text: "",
        voiceFileId: "file-1",
      },
    );

    expect(text).toContain("could not be downloaded");
  });

  test("a voice note without a key says what is missing", async () => {
    delete process.env.GEMINI_API_KEY;
    try {
      expect(mediaUnderstandingAvailable()).toBe(false);
      const text = await resolveIncomingText(
        clientWith(async () => ({
          bytes: new Uint8Array([1, 2, 3]),
          mimeType: "audio/ogg",
        })),
        { chatId: "c", text: "", voiceFileId: "file-1" },
      );

      expect(text).toContain("no media understanding");
    } finally {
      if (GEMINI_KEY !== undefined) process.env.GEMINI_API_KEY = GEMINI_KEY;
    }
  });

  test("a photo without a key keeps its caption and says the rest is unread", async () => {
    delete process.env.GEMINI_API_KEY;
    try {
      const text = await resolveIncomingText(
        clientWith(async () => ({
          bytes: new Uint8Array([1, 2, 3]),
          mimeType: "image/jpeg",
        })),
        { chatId: "c", text: "look at this", photoFileIds: ["p1"] },
      );

      expect(text).toContain("look at this");
      expect(text).toContain("no media understanding");
    } finally {
      if (GEMINI_KEY !== undefined) process.env.GEMINI_API_KEY = GEMINI_KEY;
    }
  });

  test("a document rides as caption plus a note", async () => {
    const text = await resolveIncomingText(
      clientWith(async () => null),
      {
        chatId: "c",
        text: "read this",
        documentFileId: "d1",
        documentName: "notes.pdf",
      },
    );

    // No download attempted for documents: the turn reads what the caption says.
    expect(text).toContain("read this");
    expect(text).toContain("notes.pdf");
  });
});

describe("createRateLimiter", () => {
  test("twenty takes pass, the twenty-first does not", () => {
    const limiter = createRateLimiter(20);
    for (let index = 0; index < 20; index += 1) {
      expect(limiter.take("chat")).toBe(true);
    }
    expect(limiter.take("chat")).toBe(false);
  });

  test("chats are bucketed separately", () => {
    const limiter = createRateLimiter(1);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });
});
