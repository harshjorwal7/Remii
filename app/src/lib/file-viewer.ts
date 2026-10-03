import {
  type AttachmentKind,
  classifyAttachment,
} from "@/lib/channels/attachments";

/**
 * How one saved file is shown, decided by what the file IS rather than by what it is called.
 *
 * A viewer is a small switch with a wrong default. The default that costs the least when it is
 * wrong is "download this" — so `binary` and anything unrecognised get it, and only a type the
 * server earned from the bytes earns a richer surface.
 *
 * The types come from {@link classifyAttachment}, which is the same function the upload route
 * decided to accept the file with and the same one the server serves its `Content-Type` from. Three
 * answers from one function is the point: a viewer that disagreed with the server about a file's
 * type is how a browser ends up rendering something as the wrong kind of thing.
 */
export type ViewerKind =
  | "image"
  | "text"
  | "pdf"
  | "audio"
  | "video"
  | "office"
  | "download";

export function viewerFor(mimeType: string | null | undefined): ViewerKind {
  const kind: AttachmentKind = classifyAttachment(mimeType ?? "");
  switch (kind) {
    case "image":
      return "image";
    case "text":
      return "text";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "document":
      // A PDF has a viewer the browser brings; the three OOXML formats do not, and showing a Word
      // document in an `<iframe>` gives a person a blank page and a download button.
      return mimeType === "application/pdf" ? "pdf" : "office";
    default:
      // `binary` and both refusals. A refused type cannot be in the list, and a binary has nothing
      // to render — but a refusal still has bytes behind it somewhere, so the download path is
      // offered rather than an apology.
      return "download";
  }
}

/**
 * Whether a viewer is worth rendering, as opposed to showing a note.
 *
 * An office document and an unreadable binary both come out as "there is nothing to show here", and
 * they are not the same message: one has a page the browser could draw if the app had a renderer,
 * and the other is a file the app cannot read at all. The two notes are written where they are
 * shown, for that reason.
 */
export function viewerExplains(viewer: ViewerKind): boolean {
  return viewer === "office" || viewer === "download";
}

/**
 * Whether a file's text can be copied.
 *
 * True for the kinds whose text the app actually has: the extracted text of a document, and the
 * bytes of a text file. False for an image, a video, and a binary — and the distinction matters
 * because "Copy" on a file with no text produces an empty clipboard, which reads as a broken button
 * rather than as an absent one.
 */
export function isCopyable(viewer: ViewerKind, extractedText: string): boolean {
  if (viewer === "text") return true;
  // A document's extracted text is a lossy reading of a PDF, and it is real text, so it is worth
  // copying — but an office document whose extraction failed has none, and the button follows the
  // text rather than the type.
  return (viewer === "pdf" || viewer === "office") && extractedText.length > 0;
}
