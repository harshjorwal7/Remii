/**
 * What may be attached to a message, and how much of it.
 *
 * One declaration read from both sides, the same as `routine-firing.ts`: the composer refuses a
 * file before uploading it and the server refuses it again on arrival, and those two refusals have
 * to agree. A limit written twice is a limit that drifts, and the drift shows up as a file the
 * composer accepted and the server threw away with no explanation.
 */

export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/**
 * A hard ceiling, not a downscaling threshold: nothing in this path resizes
 * or re-encodes an image, so a file under this limit is stored and sent
 * whole. `resolvePart` (`server/src/channels/attachment-parts.ts`) then
 * base64-encodes those bytes into a single content part, which runs about
 * 4/3 the byte size — a file at this ceiling becomes a part of roughly
 * 10.7 MB.
 *
 * This deployment only ever targets `openai` (`tenant-package.ts` refuses
 * to load a package whose `model.provider` is anything else), and OpenAI's
 * vision input limit is 20 MB per image. 8 MB was chosen, not the 15 MB
 * that would sit exactly at that line, because it is the encoded form that
 * has to fit under the provider's number, not the stored one, and because
 * it is not certain from that number alone which side of the encoding it
 * was measured on — so this sits at roughly half of it either way.
 *
 * Downscaling is deliberately not built yet: a file over this ceiling is
 * refused at pick time rather than shrunk, and building the shrink step is
 * a known follow-up, not something this constant can stand in for.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * How large a text file may be UPLOADED. Not how much of it the model reads.
 *
 * Text files are not downscaled, so this is a hard refusal like `MAX_IMAGE_BYTES`.
 *
 * THIS IS NOT THE LIMIT THAT DECIDES WHAT REACHES THE MODEL, AND THE TWO NUMBERS ARE FAR APART.
 * `MAX_EXTRACTED_CHARACTERS` below is 120,000, and this is 1,048,576. A file accepted at this
 * ceiling is stored whole and then handed to the model as its first 120,000 characters — for
 * ASCII-ish text, where a byte is a character, roughly its first EIGHTH, with about 89% cut. Text
 * in a script that costs several bytes per character loses proportionally less, because the
 * ceilings are counted in different units, but a file anywhere near this size is cut.
 *
 * The two are deliberately different numbers because they bound different things, and neither can
 * stand in for the other:
 *
 *   - this one bounds what is UPLOADED, STORED and SERVED — bandwidth, disk, and the size of the
 *     response `/api/attachments/:id` has to produce;
 *   - `MAX_EXTRACTED_CHARACTERS` bounds what one attachment may spend of a shared CONTEXT WINDOW,
 *     which is a budget split with the conversation and with up to seven other attachments.
 *
 * REJECTED: lowering this to 120,000 so the two agree. It would refuse files the app can already
 * do something useful with — the first 120,000 characters of a large CSV usually answers the
 * question that was asked of it — and would trade a partial read for no read at all.
 *
 * REJECTED: raising `MAX_EXTRACTED_CHARACTERS` to match this. A megabyte of text is a few hundred
 * thousand tokens, which is the context window this deployment targets spent entirely on one
 * attachment. That is the outcome that constant exists to prevent.
 *
 * So the gap stays, and what it costs is stated here rather than left for somebody to derive by
 * dividing one constant by the other. What is NOT yet resolved is that the person who uploads the
 * file is not told — see `MAX_EXTRACTED_CHARACTERS`.
 */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * How much extracted text may reach the model from one file.
 *
 * The real limit on a text attachment is tokens, not bytes: a one-megabyte file is a few hundred
 * thousand tokens and would fill the window on its own. 120,000 characters is roughly 30,000
 * tokens, which every model this deployment targets can hold alongside a conversation. Text past
 * this point is cut and the part says so, rather than being silently dropped.
 *
 * THE PART SAYS SO TO THE MODEL. NOBODY SAYS SO TO THE PERSON WHO ATTACHED THE FILE.
 *
 * `extractDocumentText` (`server/src/channels/attachment-parts.ts`) appends
 * `[attachment truncated at 120000 characters]` to what it sends, so the model is never left
 * answering questions about a file it read only part of without knowing. That is half the promise.
 * The other half is not kept: this ceiling is 120,000 while `MAX_FILE_BYTES` above is 1,048,576, so
 * a 1 MB CSV is accepted at pick time, uploaded whole, shown as a `1.0MB` tile — and then read by
 * the model as roughly its first eighth, with nothing anywhere in the UI saying so. Somebody who
 * asks "how many rows have status=failed" gets a confident answer about the part that fit.
 *
 * That is a real gap and it is recorded rather than fixed here, because the fix is a composer
 * change and this file is only where the number lives. What the composer needs is already exported:
 * a file whose SIZE IN BYTES exceeds this constant may be truncated, and one at or under it cannot
 * be. That direction is exact rather than approximate — UTF-8 spends at least one byte per code
 * point, so a file of N bytes can never decode to more than N characters — which makes
 * `file.size > MAX_EXTRACTED_CHARACTERS` a warning that never fires on a file that will arrive
 * whole. It is deliberately a "may", since the same byte count is fewer characters in any script
 * that costs more than a byte each.
 */
export const MAX_EXTRACTED_CHARACTERS = 120_000;

/**
 * `image/svg+xml` is deliberately absent.
 *
 * An SVG is an image and can also carry script. Served inline from this app's own origin, one
 * pasted into a channel is stored XSS against everybody in it. Nobody pastes an SVG expecting a
 * model to read it, so it is refused at the door rather than sanitised.
 */
export const ACCEPTED_IMAGE_MIME = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const ACCEPTED_TEXT_MIME = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;

/**
 * Formats the app can show and read, but not as an image or as text.
 *
 * Split out from `ACCEPTED_TEXT_MIME` because these are NOT text. A PDF is a container with
 * compressed page streams inside it and a `.docx` is a zip archive, and the only thing that makes
 * either readable is an extractor rather than a decode. They are listed separately so the limits,
 * the viewer and the extractor can each ask about their own set without re-deciding what counts as
 * what.
 *
 * The four are what the extractor below is actually built to read. `application/msword` and the rest
 * of the pre-2007 binary Office set are deliberately absent: they are a different container with a
 * different parser, and a file the app cannot read is still a file it can store and hand back whole.
 * Adding one to this list without writing its extractor would produce a file that previews as an
 * empty box.
 */
export const ACCEPTED_DOCUMENT_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

/**
 * Media the app can play inline.
 *
 * Kept small on purpose. `video/*` in particular is a browser's problem: a codec this deployment
 * cannot decode is a black rectangle, which is worse than the file's name, and the accept list below
 * can only be a guess about what the reader's browser supports. What is listed is what the common
 * browsers all handle.
 */
export const ACCEPTED_AUDIO_MIME = [
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
] as const;

export const ACCEPTED_VIDEO_MIME = [
  "video/mp4",
  "video/webm",
  "video/ogg",
] as const;

/**
 * TYPES THAT ARE REFUSED RATHER THAN STORED, AND WHY THE LIST IS A LIST.
 *
 * The app now accepts files whose type it does not recognise, which makes the default "accept"
 * rather than "refuse" — and that inverts the safety argument this file used to make by omission.
 * Before, anything not on the accepted lists was turned away, so nothing served from this origin
 * could carry script. Now the question is no longer "is this on a list" but "is serving this
 * inline dangerous", and the dangerous cases share one property: they are markup or script that a
 * browser will EXECUTE when it is served with its own content type from this origin.
 *
 * They are refused outright rather than neutralised. Serving them as
 * `application/octet-stream` with a download disposition would be safe in the same way
 * `application/octet-stream` is safe for any other binary, and the honest reason not to is that a
 * `.html` file somebody attaches to a message is nearly always meant to be read by a person opening
 * it, and a download prompt is a worse answer than a clear refusal at the door.
 *
 * `image/svg+xml` is here and is also reached by the `image/` rule in `classifyAttachment`, which
 * is why it is not repeated in the note on that function.
 */
export const INLINE_UNSAFE_MIME = [
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "application/xhtml",
  "text/x-server-parsed-html",
  "application/xslt+xml",
  "application/mathml+xml",
  "application/rdf+xml",
  "text/xsl",
] as const;

/**
 * How large a file of each kind may be, in bytes.
 *
 * A TABLE RATHER THAN A CONSTANT PER FAMILY, because the ceilings are not interchangeable and were
 * not before either. An image is bound by a provider's vision limit and by the base64 the stored
 * bytes become; text is bound by what a context window can hold; a document is bound by an
 * extractor's memory rather than by either, since a 200-page PDF is a modest file and a large amount
 * of work to parse; a media file is bound by nothing but the disk, and is the one family where the
 * only real question is whether anybody should be able to fill the volume with a video.
 *
 * `binary` is the smallest ceiling of the accepted families and that is deliberate. A file nobody can
 * preview is a file whose only use is being handed back whole, so its limit is about disk and about
 * the size of the response `/api/attachments/:id` has to produce — not about anything the app
 * reads out of it.
 *
 * The numbers are bytes, and a caller that wants a sentence to refuse with wants
 * {@link maxBytesForKind} rather than the table, so the refusal and the check cannot be written
 * against different entries.
 */
export const MAX_BYTES_BY_KIND: Readonly<Record<AttachmentKind, number>> = {
  image: MAX_IMAGE_BYTES,
  text: MAX_FILE_BYTES,
  document: 32 * 1024 * 1024,
  audio: 64 * 1024 * 1024,
  video: 256 * 1024 * 1024,
  binary: 64 * 1024 * 1024,
  // Not accepted, so nothing is ever refused against these two; present so the table is total and a
  // caller cannot index it with `undefined` on a kind it has already been told is unsupported.
  "unsupported-image": MAX_IMAGE_BYTES,
  unsupported: MAX_FILE_BYTES,
};

/**
 * The ceiling for one kind, in bytes.
 *
 * The only supported way to ask, so that a caller writing a refusal sentence is reading the same
 * entry the check was made against. Returns 0 for the two kinds that are never accepted, which reads
 * as "nothing is allowed" rather than as a missing value.
 */
export function maxBytesForKind(kind: AttachmentKind): number {
  return MAX_BYTES_BY_KIND[kind] ?? 0;
}

/**
 * THE MEDIA TYPE ON ITS OWN: LOWER CASE, PARAMETERS GONE — AND THE ONLY FORM ANYTHING HERE COMPARES.
 *
 * A `File`'s type is whatever produced it. Bun's constructor appends `;charset=utf-8` to
 * `text/plain` and `application/json`, and a browser does the same for some clipboard entries; RFC
 * 2045 makes the type case-insensitive besides, and while `new File(...)` ASCII-lower-cases what it
 * is given, a `File` this app never built — one off a drop or a clipboard — carries whatever its
 * source wrote. `sniffMimeType` already normalises the same two ways before handing its answer to
 * `classifyAttachment`.
 *
 * Exported because the composer needs the identical normalisation for a different reason: the SDK's
 * own `accept` check is a case-sensitive `file.type === filter`, so anything handed to it has to
 * have been through here first or the two gates disagree about the same file.
 */
export function mediaTypeOf(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0].trim();
}

/**
 * CLAIMS THAT NAME NO FORMAT AT ALL, AND THE ONE COPY OF THAT LIST.
 *
 * A browser sends one of these for a file it has no mapping for — a `.txt` dragged out of an
 * editor, anything with an unfamiliar extension. Both sides have to treat them the same way and for
 * a while did not: `sniffMimeType` discards such a claim and reads the bytes, so the server accepts
 * the text file behind it, while the composer screened the claim alone and refused the same file at
 * pick time. That is the drift the note at the top of this file exists to prevent, so the list lives
 * here and `attachment-mime.ts` reads it from here rather than keeping its own.
 *
 * A blank claim, and anything not shaped like a MIME type, names nothing by the same reasoning.
 */
const MIME_NAMES_NOTHING: ReadonlySet<string> = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  "application/force-download",
]);

export function namesNoFormat(mimeType: string): boolean {
  const mediaType = mediaTypeOf(mimeType);
  return !mediaType.includes("/") || MIME_NAMES_NOTHING.has(mediaType);
}

export type AttachmentKind =
  /** Shown inline as an image, and put in front of a vision-capable model as one. */
  | "image"
  /** Shown inline as text, and handed to the model as its own characters. */
  | "text"
  /**
   * Shown through a document viewer and read by an extractor, never inline as text.
   *
   * Its own kind because "it has text inside it" is not the same answer as "it IS text": a PDF
   * served as `text/plain` is a corrupt file, and a `.docx` served as `text/plain` is a zip archive
   * with a Word in it. Both are unreadable, and both would be served from this origin as text.
   */
  | "document"
  /** Played inline, never read. */
  | "audio"
  /** Played inline, never read. */
  | "video"
  /**
   * Stored, served whole, and offered as a download. Nothing is read out of it and nothing is shown
   * inline.
   *
   * This kind is what makes "any file" true. It is reached by a type that names a real format and is
   * not one of the families above, which is a deliberate inversion of the old default — see
   * `INLINE_UNSAFE_MIME` for the list that keeps the inversion from becoming unsafe.
   */
  | "binary"
  | "unsupported-image"
  | "unsupported";

/**
 * The kinds this app accepts, in the order a caller usually wants to ask about them.
 *
 * Exported so a screen can say "this app takes these" without re-deriving it, and so the composer's
 * refusals and the server's refusals are written against one list.
 */
export const ACCEPTED_KINDS = [
  "image",
  "text",
  "document",
  "audio",
  "video",
  "binary",
] as const satisfies readonly AttachmentKind[];

/**
 * `unsupported-image` is a separate answer from `unsupported` so the refusal can name the real
 * problem. "That is not a supported image type" tells somebody with a HEIC photo what to do;
 * "unsupported file" leaves them guessing whether images work at all.
 *
 * THE MIME TYPE AND NOTHING ELSE, WHICH IS WHY THE FILENAME IS NO LONGER ASKED FOR. This took
 * `{ name, mimeType }` and read only the second, and the dead argument was not merely untidy: it
 * read as a promise that a file called `notes.txt` would be given the benefit of the doubt, which
 * is exactly the doubt the composer's callers had. It must not be kept, either. The server calls
 * this with the type `sniffMimeType` earned from the BYTES, and letting an extension override that
 * answer is how a binary blob named `.txt` — or an empty file, which sniffs to
 * `application/octet-stream` on purpose — would be stored and served from this origin as text.
 * Where a name does deserve the benefit of the doubt the door is `namesNoFormat`, and it is the
 * client's alone: it is asked of a claim nobody has corroborated yet, not of an answer the bytes
 * have already given.
 */
export function classifyAttachment(mimeType: string): AttachmentKind {
  /*
   * The media type decides, and it is the type `sniffMimeType` earned from the bytes — never the
   * filename. See the note on this function.
   */
  const mediaType = mediaTypeOf(mimeType);
  if ((ACCEPTED_IMAGE_MIME as readonly string[]).includes(mediaType)) {
    return "image";
  }
  if (mediaType.startsWith("image/")) return "unsupported-image";
  if ((ACCEPTED_TEXT_MIME as readonly string[]).includes(mediaType)) {
    return "text";
  }
  if ((ACCEPTED_DOCUMENT_MIME as readonly string[]).includes(mediaType)) {
    return "document";
  }
  if ((ACCEPTED_AUDIO_MIME as readonly string[]).includes(mediaType)) {
    return "audio";
  }
  if ((ACCEPTED_VIDEO_MIME as readonly string[]).includes(mediaType)) {
    return "video";
  }

  /*
   * Refused by name, before the `binary` default below.
   *
   * The order matters and it is the whole reason this function is safe to end in `binary`. These
   * are the types a browser will EXECUTE when this origin serves them with their own content type,
   * and they include several that are not `image/*` and so never reach the rule above — `text/xml`
   * and `application/xslt+xml` among them. A list checked after the default would be a list that
   * never fires.
   */
  if ((INLINE_UNSAFE_MIME as readonly string[]).includes(mediaType)) {
    return "unsupported";
  }

  /*
   * Anything else that NAMES a format is `binary`: stored, served whole, offered as a download.
   *
   * A claim that names no format at all is not `binary` — it is `unsupported`, because on arrival
   * the server has already thrown such a claim away and sniffed the bytes (`sniffMimeType`), so
   * reaching this point with one means the caller is the composer, screening a file it has not
   * uploaded yet and whose bytes it has not seen. Treating "I don't know what this is" as a licence
   * to accept anything would put the whole sniffing layer behind a browser's shrug.
   */
  if (namesNoFormat(mediaType)) return "unsupported";
  return "binary";
}

/**
 * Whether a paste is an attachment or an ordinary text paste.
 *
 * Text wins whenever the clipboard carries any. A file is ours only when there is no text to
 * prefer.
 *
 * This is the one rule here that is NOT T3 Code's. Theirs claims an image even when text came with
 * it, on the reasoning that an image is unambiguously what was meant. It is not: copying a cell
 * from a spreadsheet, or a block from a word processor, puts an `image/png` rendering of the
 * selection on the clipboard ALONGSIDE the text. Under "an image always wins" that paste attached a
 * screenshot of the cell and typed nothing — verified in Chrome against the real app, not
 * theorised.
 *
 * A screenshot carries no text at all, so the case this rule exists for is untouched.
 *
 * DECLINING A PASTE IS NOT THE SAME AS THE TEXT BEING TYPED, AND FOR SOME SOURCES IT IS NOT WHAT
 * HAPPENS. This function only says "not ours". What the paste then does is PromptArea's rule, and
 * that rule is: if the clipboard carries an image AND the `text/html` is Microsoft Office markup —
 * it looks for `urn:schemas-microsoft-com:office`, a `ProgId` name, a `Mso` class, or an `mso-*`
 * property — the text is inserted and the image ignored. Anything else with an image on the
 * clipboard calls `onImagePaste` and RETURNS, having already called `preventDefault` and inserted
 * nothing.
 *
 * So the two halves of the spreadsheet case land differently, and it is worth being exact about
 * which is which:
 *
 *   - Word and Excel put Office markup in the `text/html`. Their text is typed. Handled.
 *   - Google Sheets, Numbers, and every other source that behaves like Office without being it,
 *     take the second branch. Their IMAGE is attached and THEIR TEXT IS NOT TYPED — the same
 *     outcome "an image always wins" gave, arrived at by a different route.
 *
 * That second bullet is a known defect and is being kept for now rather than fixed, so this comment
 * says so instead of implying the spreadsheet case is covered. Fixing it means teaching this rule
 * or PromptArea's the difference between an image that IS the selection and an image that merely
 * accompanies it, which no clipboard flag reports.
 *
 * The other trade-off, stated because it is also real: copying an image from a web page can put the
 * image's URL in `text/plain`, and that pastes the URL rather than attaching the image. Drag or the
 * `+` button still attach it, and a URL landing in the box is visible and undoable — where a
 * swallowed paste is neither.
 */
export function shouldClaimPaste(input: {
  kinds: readonly AttachmentKind[];
  plainText: string;
}): boolean {
  if (input.plainText.length > 0) return false;
  return input.kinds.length > 0;
}

/**
 * What a sent message carries instead of the bytes.
 *
 * This is an AG-UI `image`/`document` part with a URL source, NOT a part type of our own. AG-UI has
 * no reference member: `RunAgentInputSchema.parse` rejects `{type:"attachment"}` outright and the
 * runtime answers 400, verified against the installed 0.0.59 schema. The union is
 * `text | image | audio | video | document | binary`, and a source is `{type:"data"|"url"}` — there
 * is no `base64` literal and no `media_type` key anywhere.
 *
 * The URL is relative and is never fetched by a provider. `copilot.ts` swaps the source for
 * `{type:"data", value:<base64>}` as the run is built, which is what keeps the bytes out of the
 * stored thread while still putting the image in front of the model. `metadata` carries the id
 * because it is `z.unknown().optional()` and survives the parse; a sibling key would be silently
 * stripped.
 */
export type AttachmentSource =
  | { type: "data"; value: string; mimeType: string }
  | { type: "url"; value: string; mimeType?: string };

export type AttachmentPart = {
  type: "image" | "document";
  source: AttachmentSource;
  metadata?: { attachmentId: string; filename?: string };
};

/** The relative URL form stored in a sent message. Resolved server-side, never by a provider. */
export function attachmentUrl(attachmentId: string): string {
  return `/api/attachments/${attachmentId}`;
}
