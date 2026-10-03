import {
  ACCEPTED_KINDS,
  type AttachmentKind,
  classifyAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  maxBytesForKind,
  mediaTypeOf,
  namesNoFormat,
} from "@/lib/channels/attachments";
import { newId } from "@/lib/new-id";
import type { RejectedFile } from "./rejected-files";

/**
 * Pure boundary between a raw file pick (drag, paste, or the file dialog) and what the composer
 * is willing to stage. Nothing here touches state or the network: it only sorts files the caller
 * already has in hand into what to keep and what to refuse, and why.
 */

/**
 * What to call a kind in a refusal, so the sentence reads as English.
 *
 * Not the kind's own name: "too large for a binary attachment" tells somebody holding a `.zip`
 * nothing, and the limit that refused them is worth more than the category it fell into.
 */
const KIND_NOUN: Record<AttachmentKind, string> = {
  image: "image",
  text: "text",
  document: "document",
  audio: "audio",
  video: "video",
  binary: "file",
  "unsupported-image": "image",
  unsupported: "file",
};

/**
 * "a" or "an" for a kind noun.
 *
 * Trivial, and here because the alternative is a refusal that says "too large for a image", which
 * is the sentence a person reads when they are trying to work out whether the app is working.
 */
function article(noun: string): string {
  return `${"aeiou".includes(noun.charAt(0)) ? "an" : "a"} ${noun}`;
}

export type ScreenedFiles = {
  accepted: File[];
  rejected: RejectedFile[];
};

/**
 * Kind and size are judged before the per-message cap is ever consulted, and the cap only counts
 * files that already cleared both. A refused SVG (or an oversized image) must never eat a slot
 * that a real, acceptable file could have used — so a file that fails kind or size is rejected
 * before it can be charged against `MAX_ATTACHMENTS_PER_MESSAGE`, and the cap check only runs
 * against files that made it this far.
 */
export function screenPickedFiles(
  files: readonly File[],
  options: { alreadyStaged: number },
): ScreenedFiles {
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];

  for (const file of files) {
    /*
     * The same normalisation `classifyAttachment` runs, because the wording below has to be about
     * the same string the kind was decided from. It used to compare `file.type` raw, so an SVG off
     * a clipboard (`image/svg+xml;charset=utf-8`) was still refused — but with the generic image
     * sentence rather than the one that says why this format in particular is not accepted. The
     * server gives the specific reason for the same file, so the two refusals disagreed.
     */
    const mediaType = mediaTypeOf(file.type);
    const kind = classifyAttachment(file.type);

    if (kind === "unsupported-image") {
      rejected.push(
        reject(
          file,
          mediaType === "image/svg+xml"
            ? `'${file.name}' is an SVG, which can carry scripts and is not accepted.`
            : `'${file.name}' is an image format that is not supported.`,
        ),
      );
      continue;
    }

    /*
     * THE BROWSER TOLD US NOTHING, SO THE SERVER GETS TO LOOK — AND ONLY THEN.
     *
     * A claim that names no format is not a refusal, it is an absence: `sniffMimeType` throws
     * exactly these claims away and reads the bytes, so the server accepts the plain text file
     * behind an `application/octet-stream` that this screen used to turn away with "not a file type
     * this chat accepts" — a sentence written by the half of the system that had not looked at it.
     *
     * A claim that DOES name a format is still refused here, because there the two halves already
     * agree: `sniffMimeType` hands such a name straight back for the server to refuse by name.
     *
     * The cost, stated because it is real: a genuinely unreadable file the browser could not name
     * now takes a round trip to be refused, in the server's words rather than ours. That is the
     * right way round. The server has the bytes; this screen has a string somebody else wrote.
     */
    const unnamed = kind === "unsupported" && namesNoFormat(mediaType);

    if (kind === "unsupported" && !unnamed) {
      rejected.push(
        reject(file, `'${file.name}' is not a file type this chat accepts.`),
      );
      continue;
    }

    /*
     * One size check for every accepted kind, against the table the server also reads.
     *
     * This used to be two `if` blocks naming `MAX_IMAGE_BYTES` and `MAX_FILE_BYTES` directly,
     * because there were two accepted families. There are six now, and a sixth `if` block is not
     * what the seventh family should need: the ceilings differ in number AND in unit — a document
     * is bound by an extractor's memory, a media file by nothing but the disk — which is exactly the
     * thing a hand-written check per family gets wrong. `maxBytesForKind` is the same function the
     * sentence is written from, so the refusal cannot quote a limit other than the one it applied.
     */
    if (ACCEPTED_KINDS.includes(kind as (typeof ACCEPTED_KINDS)[number])) {
      const limit = maxBytesForKind(kind);
      if (limit > 0 && file.size > limit) {
        rejected.push(
          reject(
            file,
            `'${file.name}' is too large for ${article(KIND_NOUN[kind])} attachment (limit ${formatBytes(limit)}).`,
          ),
        );
        continue;
      }
    }

    // The LOOSE ceiling for a file nobody has named yet, because this screen does not know which
    // of the two limits applies to it. Guessing the tight one would put back exactly the refusal
    // this branch exists to remove; the server applies the right limit once it has the bytes.
    if (unnamed && file.size > MAX_IMAGE_BYTES) {
      rejected.push(
        reject(
          file,
          `'${file.name}' is larger than the ${formatBytes(MAX_IMAGE_BYTES)} limit for an attachment.`,
        ),
      );
      continue;
    }

    if (
      options.alreadyStaged + accepted.length >=
      MAX_ATTACHMENTS_PER_MESSAGE
    ) {
      rejected.push(
        reject(
          file,
          `'${file.name}' was not added: a message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`,
        ),
      );
      continue;
    }

    accepted.push(file);
  }

  return { accepted, rejected };
}

/**
 * `newId()` RATHER THAN `crypto.randomUUID()`, AND THE DIFFERENCE HERE IS NOT COSMETIC.
 *
 * `crypto.randomUUID` exists only in a secure context. On a deployment reached at plain
 * `http://<address>` it is not there at all, so the call does not return a worse id — it THROWS.
 * The throw comes out of `screenPickedFiles`, the single door every drag, paste and file dialog
 * goes through, and it takes the WHOLE PASS with it: one SVG in a drop of eight and the seven good
 * files beside it are never staged either, with no chip, no refusal, and nothing on screen saying
 * why the gesture did nothing. The one function whose entire purpose is that a refused file still
 * gets a sentence would be the function that swallowed the drop in silence. See `lib/new-id.ts`.
 */
function reject(file: File, reason: string): RejectedFile {
  return { id: newId(), name: file.name, reason };
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
