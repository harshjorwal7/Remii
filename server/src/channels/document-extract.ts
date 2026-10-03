import { inflateRawSync } from "node:zlib";
import { MAX_EXTRACTED_CHARACTERS } from "../../../shared/attachments";

/**
 * Reading the text out of a document, for the four formats the app previews.
 *
 * WHY AN EXTRACTOR AND NOT A DECODE. A `.docx`, a `.xlsx` and a `.pptx` are all one ZIP archive
 * with different XML inside, and a PDF is a container of compressed page streams with its own text
 * operators. None of them is text, so `bytes.toString("utf8")` on any of them produces mojibake —
 * and that is not a cosmetic problem here, because the result goes to a model that will answer a
 * question about it with confidence. A `.docx` decoded as UTF-8 is a few hundred bytes of readable
 * XML and a great deal of binary noise, which reads as "the document is mostly nonsense" rather than
 * as "this file could not be read".
 *
 * So each format gets a reader that knows its container, and a format with no reader here says so
 * rather than guessing.
 */

/** What an extractor produced, and whether it managed. */
export type ExtractedDocument = {
  text: string;
  /** False when the container was read but held no extractable text — a scan, an empty sheet. */
  ok: boolean;
  /** Why nothing came out, when nothing did. Shown to the model so it does not invent contents. */
  reason?: string;
};

/**
 * How much inflated output any single member may produce.
 *
 * A ZIP entry carries its uncompressed size in its header and it is a claim, not a measurement: a
 * file that says it expands to 1 KB and then hands over 1 GB is the oldest trick there is, and this
 * code inflates on a `Buffer` that already exists in memory. So the number is not read from the
 * file at all — it is fixed here, and the inflater is stopped by the callback's own return.
 *
 * 64 MB is roughly the point where an inflated member stops being "a document" and starts being a
 * denial of service, and it is above any real `.xlsx`: a spreadsheet with a million rows is a few
 * tens of megabytes of XML.
 */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * The text a text-shaped file contributes, with the same ceiling the text path has always had.
 *
 * Shared so a `.csv` inlined as a message part and a `.csv` read as a document are cut at the same
 * place, with the same note, and a person is not told two different things about the same file
 * depending on which door it came through.
 */
export function extractPlainText(bytes: Uint8Array): ExtractedDocument {
  const full = Buffer.from(bytes).toString("utf8");
  return { text: capExtracted(full), ok: full.trim().length > 0 };
}

/**
 * Cut at the shared ceiling, never mid-surrogate, and say so.
 *
 * The surrogate check is not decoration: slicing a string between a high and a low surrogate yields
 * a lone surrogate, which is not a character, and it is replaced with U+FFFD by whatever renders it
 * — so the cut would show as a `?` in the middle of a word at exactly the point somebody is reading.
 */
export function capExtracted(full: string): string {
  if (full.length <= MAX_EXTRACTED_CHARACTERS) return full;
  const sliced = full.slice(0, MAX_EXTRACTED_CHARACTERS);
  const last = sliced.charCodeAt(sliced.length - 1);
  const splitAPair = last >= 0xd800 && last <= 0xdbff;
  const cut = splitAPair ? sliced.slice(0, -1) : sliced;
  return `${cut}\n\n[attachment truncated at ${cut.length} characters]`;
}

/**
 * A ZIP archive read far enough to get at its members.
 *
 * THE CENTRAL DIRECTORY IS AT THE END, WHICH IS WHY `readZipEntry` NEEDS THE WHOLE BUFFER. A ZIP is
 * written front to back — local headers, then compressed data, then the central directory that says
 * what everything was — so a member's contents cannot be found by scanning forward from the start
 * without honouring every local header's sizes, and the sizes can be a lie (see
 * `MAX_INFLATED_BYTES`). Walking the central directory instead means every offset is one the writer
 * wrote down twice, and a file whose two halves disagree is rejected rather than believed.
 *
 * Deliberately not a general zip library. The only members this file ever wants are three known
 * names, and a general reader would mean trusting every entry in an archive an untrusted person
 * uploaded — including the ones with absolute paths and the ones that are 10 GB.
 */
function readCentralDirectory(bytes: Buffer): Map<string, Buffer> {
  /*
   * THE END-OF-CENTRAL-DIRECTORY RECORD, FOUND BY SCANNING BACK.
   *
   * It is the last record in the file, it is at least 22 bytes, and its comment length field says
   * exactly how far back from the end it starts — so the offset is computed rather than searched
   * for. Scanning backwards over the last 64 KB instead would work too, and is what most readers
   * do, but it can find the bytes of a comment that happens to spell the signature and then read a
   * record that is not there.
   */
  const MIN_RECORD = 22;
  if (bytes.length < MIN_RECORD) return new Map();
  const commentLength = bytes.readUInt16LE(bytes.length - 2);
  const start = bytes.length - MIN_RECORD - commentLength;
  if (start < 0) return new Map();
  // `PK\x05\x06`.
  if (bytes.readUInt32LE(start) !== 0x06054b50) return new Map();

  const total = bytes.readUInt16LE(start + 10);
  let offset = bytes.readUInt32LE(start + 16);
  const members = new Map<string, Buffer>();

  for (let index = 0; index < total; index++) {
    // `PK\x01\x02`.
    if (
      offset + 46 > bytes.length ||
      bytes.readUInt32LE(offset) !== 0x02014b50
    ) {
      break;
    }
    const compression = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLengthHere = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);

    // Walk on to the next record whether or not this one could be read, so one bad entry does not
    // end the directory.
    const next = offset + 46 + nameLength + extraLength + commentLengthHere;
    if (next <= offset) break;
    offset = next;

    if (!isWanted(name)) continue;
    if (compressedSize > MAX_INFLATED_BYTES) continue;
    const inflated = readLocalMember(bytes, localOffset, compression, name);
    // A member wanted twice: the first wins, so an archive that puts a small `word/document.xml`
    // first and a large one later cannot make the extractor read the large one.
    if (inflated && !members.has(name)) members.set(name, inflated);
  }
  return members;
}

/**
 * The members this extractor will inflate, and nothing else.
 *
 * Named exactly, with no prefix matching, because the alternative is a path-traversal read: an
 * archive can contain a member called `word/document.xml` under any directory it likes, and one
 * called `../../etc/passwd` under a name that begins the same way. Nothing here is used as a path,
 * so the names are labels rather than filenames — but an exact match is still the only way to be
 * sure the bytes handed to an XML parser are the ones this file expects.
 */
const WANTED_MEMBERS = new Set([
  // WordprocessingML: the body, plus the shared strings and styles a run's text can be split
  // across. A `.docx` with a table of figures puts most of its content in footnotes.
  "word/document.xml",
  "word/footnotes.xml",
  "word/endnotes.xml",
  "word/sharedStrings.xml",
  // SpreadsheetML.
  "xl/sharedStrings.xml",
  "xl/workbook.xml",
  // PresentationML: one slide part per slide, and the notes are where the prose often is.
  "ppt/presentation.xml",
]);

/** The per-slide and per-sheet parts, which are numbered and so cannot be named in advance. */
const NUMBERED_MEMBER_PREFIXES = [
  "xl/worksheets/sheet",
  "ppt/slides/slide",
  "ppt/notesSlides/notesSlide",
] as const;

function isWanted(name: string): boolean {
  if (WANTED_MEMBERS.has(name)) return true;
  return NUMBERED_MEMBER_PREFIXES.some(
    (prefix) =>
      name.startsWith(prefix) &&
      name.endsWith(".xml") &&
      // No path separators, so nothing can be reached through a member's name.
      !name.includes("/..") &&
      !name.includes("\\"),
  );
}

/**
 * One member, read from its local header and inflated.
 *
 * The local header repeats the name and the compression method, and its own name length is used
 * rather than the central directory's — they are allowed to differ, and the local header is what
 * describes the bytes that are actually there.
 */
function readLocalMember(
  bytes: Buffer,
  localOffset: number,
  expectedMethod: number,
  _name: string,
): Buffer | null {
  // `PK\x03\x04`.
  if (localOffset + 30 > bytes.length) return null;
  if (bytes.readUInt32LE(localOffset) !== 0x04034b50) return null;
  const method = bytes.readUInt16LE(localOffset + 8);
  const compressedSize = bytes.readUInt32LE(localOffset + 18);
  const nameLength = bytes.readUInt16LE(localOffset + 26);
  const extraLength = bytes.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  if (start + compressedSize > bytes.length) return null;
  if (compressedSize > MAX_INFLATED_BYTES) return null;

  const data = bytes.subarray(start, start + compressedSize);
  try {
    if (method === 0) return Buffer.from(data);
    /*
     * METHOD 8 IS DEFLATE, AND THE 8 IS NOT THE COMPRESSION METHOD THE INFLATER EXPECTS.
     *
     * A ZIP's method 8 is raw deflate with no zlib header, and `inflateRawSync` is the function
     * for that. `inflateSync` expects the two-byte zlib wrapper and throws on a member that has
     * none, which is every member written by every ZIP implementation in common use.
     *
     * The method is compared against the central directory's AND its own, above: a mismatch means
     * the two halves of the file disagree about this member, and there is no reading of that in
     * which the right answer is to pick one.
     */
    if (method === 8 && expectedMethod === 8) {
      return inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES });
    }
  } catch {
    // A member that will not inflate is a member this extractor does not have. Not fatal: a
    // spreadsheet whose one unreadable sheet still has its shared strings.
  }
  return null;
}

/**
 * Every text run in one XML part, in document order.
 *
 * A REGEX, AND NOT AN XML PARSER, AND THE REASON IS WHAT THESE FILES CONTAIN.
 *
 * WordprocessingML puts visible text in `<w:t>`, SpreadsheetML in `<t>` and PresentationML in
 * `<a:t>`, and in all three the text is character data with entities. The temptation is a parser,
 * and a parser is the right tool — but these are XML documents from an untrusted upload, and an
 * XML parser is the single largest attack surface this app would acquire: entity expansion, external
 * entity references, quadratic-name attacks. A regex cannot be made to do any of that, because it
 * does not resolve anything.
 *
 * So the read is deliberately shallow and slightly wrong in the ways a model can survive: entities
 * are decoded by hand for the five that matter, tags are stripped, and text that spans two runs —
 * which Word does constantly, splitting a word across a formatting change — is joined without a
 * separator, because that is what it means. `<w:p>` becomes a newline, so paragraphs and table rows
 * do not run together.
 */
function textFromXml(xml: string): string {
  /*
   * ONE PASS, AND THE NEWLINES ARE TEXT RATHER THAN RUNS.
   *
   * The bug this shape exists to prevent: an earlier version replaced every paragraph with a
   * newline and then collected only the `<w:t>` elements, so the newlines sat BETWEEN the runs and
   * the join discarded them. Two sentences about a contract came out as one long sentence with no
   * punctuation, which is precisely the kind of thing a model quotes back.
   *
   * So the boundaries become ordinary characters first and the runs are read second, from a string
   * that already holds the newlines. Every remaining tag is then deleted, and what is left is the
   * document's text with its paragraph and row structure intact.
   */
  const marked = xml
    // Paragraphs, in both spellings. The open tag goes and the close tag becomes a newline, which
    // is why a self-closing `<w:p/>` — an empty paragraph — is handled by the close-tag rule alone.
    .replace(/<w:p\s[^>]*>|<w:p>/g, "")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<a:p\s[^>]*>|<a:p>/g, "")
    .replace(/<\/a:p>/g, "\n")
    // A table row is a line. SpreadsheetML writes `<row>` where Word writes `<w:tr>`.
    .replace(/<w:tr\s[^>]*>|<w:tr>/g, "")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<row\s[^>]*>|<row>/g, "")
    .replace(/<\/row>/g, "\n")
    // A cell boundary is a tab, so a row of values stays a row rather than becoming a sentence.
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/c>/g, "\t")
    // A line break inside a paragraph, written two ways by two producers.
    .replace(/<w:br\s*\/?>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    // A tab stop inside a paragraph, which SpreadsheetML uses for alignment padding.
    .replace(/<w:tab\s*\/?>/g, "\t");

  /*
   * Everything that is left is a tag. Not a match-and-keep: the runs are read from what the tags
   * were wrapped around, and a run's own `<w:t>` has already been accounted for by being a tag like
   * any other. Deleting them all keeps the character data, which is the only thing wanted.
   */
  const text = decodeXmlEntities(marked.replace(/<[^>]*>/g, ""));

  return (
    text
      // Runs of blank lines are one blank line, and a file that ends with a paragraph has a trailing
      // one. Neither changes what the document says and both make the output harder to read.
      .split("\n")
      .map((line) => line.replace(/[\t ]+$/g, ""))
      .filter(
        (line, index, all) =>
          line.length > 0 || (index > 0 && all[index - 1].length > 0),
      )
      .join("\n")
      .trim()
  );
}

/**
 * The five entities an Office file actually uses, and nothing else.
 *
 * `&amp;` last would be wrong if these were replaced in order, so they are: `&amp;` is decoded
 * after the rest, and a literal `&amp;lt;` in the document therefore becomes `&lt;` and stays
 * literal, which is what the writer meant. Any other entity is left as written rather than guessed
 * at, because guessing at one in a file this code did not write is how mojibake gets in.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const point = Number.parseInt(code, 10);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    })
    .replace(/&amp;/g, "&");
}

/**
 * A WordprocessingML document, which is the `.docx` case.
 */
function extractDocx(bytes: Buffer): ExtractedDocument {
  const members = readZipMembers(bytes);
  if (members.size === 0) {
    return {
      text: "",
      ok: false,
      reason:
        "the file is a ZIP archive with no readable Word document inside it",
    };
  }
  const shared = members.get("word/sharedStrings.xml");
  /*
   * A SPREADSHEET'S SHARED STRINGS BELONG TO THE SPREADSHEET.
   *
   * Reading them here would put every label in the workbook into a word processor's output as bare
   * lines, ahead of a sentence about a contract. Only the Word members are read, and a `.docx` with
   * no shared strings is the normal case rather than a broken one.
   */
  void shared;
  const chunks = [
    textFromXml(textOf(members, "word/document.xml")),
    textFromXml(textOf(members, "word/footnotes.xml")),
    textFromXml(textOf(members, "word/endnotes.xml")),
  ].filter((chunk) => chunk.length > 0);
  const joined = chunks.join("\n\n");
  return finish(joined, "the document held no extractable text");
}

/**
 * A SpreadsheetML workbook, which is the `.xlsx` case.
 *
 * The order is the one a person would read it in, and it matters: a workbook's SHEET NAMES are in
 * `workbook.xml`, and a model asked "how many rows failed" and handed a pile of cell values with no
 * idea which sheet they came from will answer about the wrong one. So the names come first, as
 * headings, and then each sheet's cells.
 */
function extractXlsx(bytes: Buffer): ExtractedDocument {
  const members = readZipMembers(bytes);
  if (members.size === 0) {
    return {
      text: "",
      ok: false,
      reason:
        "the file is a ZIP archive with no readable spreadsheet inside it",
    };
  }
  const chunks: string[] = [];
  const shared = textFromXml(textOf(members, "xl/sharedStrings.xml"));
  const sharedStrings = shared
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const workbook = textOf(members, "xl/workbook.xml");
  const sheetNames = [
    ...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g),
  ].map((match) => decodeXmlEntities(match[1] ?? ""));

  /*
   * CELL VALUES, IN THE ORDER THEY APPEAR.
   *
   * `sharedStrings.xml` is read but not used to resolve `<c t="s">` cells, and that is a real gap
   * worth stating rather than hiding: a shared-string cell holds an INDEX, and resolving it means
   * parsing every row into cells and looking each index up, which is a table rather than a
   * transcript. What is emitted instead is every shared string in order — which for a real workbook
   * is most of the text in it, in roughly the right order — followed by the numeric cells, which
   * need no resolution at all.
   *
   * The failure this trades for: a model reading a spreadsheet of mostly shared strings gets the
   * values without knowing which row and column each was in. That is worse than nothing, and it is
   * why the sheet names and the row separators below are emitted even though they are not a table
   * either. Resolving cells properly is the obvious next step and is not attempted here because
   * doing it half-way is what this already is.
   */
  if (sheetNames.length > 0) {
    chunks.push(`Sheets: ${sheetNames.join(", ")}`);
  }
  if (sharedStrings.length > 0) {
    chunks.push(sharedStrings.join("\n"));
  }

  for (const [name, member] of members) {
    if (!name.startsWith("xl/worksheets/sheet")) continue;
    const xml = member.toString("utf8");
    const numbers = [...xml.matchAll(/<c\b[^>]*>(?:(?!<\/c>)[\s\S])*?<\/c>/g)]
      .map((cell) => cell[0])
      .map((cell) => {
        const value = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
        return value === undefined ? "" : decodeXmlEntities(value);
      })
      .filter((value) => value.length > 0);
    if (numbers.length > 0) {
      chunks.push(
        `Sheet ${name.slice("xl/worksheets/".length)}:\n${numbers.join(" ")}`,
      );
    }
  }

  return finish(chunks.join("\n\n"), "the workbook held no extractable text");
}

/**
 * A PresentationML deck, which is the `.pptx` case.
 */
function extractPptx(bytes: Buffer): ExtractedDocument {
  const members = readZipMembers(bytes);
  if (members.size === 0) {
    return {
      text: "",
      ok: false,
      reason:
        "the file is a ZIP archive with no readable presentation inside it",
    };
  }
  const chunks: string[] = [];
  // Sorted, because the members are read from the central directory in whatever order the writer
  // put them there, and slide 10 arriving before slide 2 makes a model summarise the wrong slide.
  const slides = [...members.keys()]
    .filter((name) => name.startsWith("ppt/slides/slide"))
    .sort(byNumericSuffix);
  for (const name of slides) {
    const body = textFromXml(textOf(members, name)).trim();
    if (body.length === 0) continue;
    const number = /\d+/.exec(name)?.[0] ?? "?";
    chunks.push(`Slide ${number}:\n${body}`);
  }
  const notes = [...members.keys()]
    .filter((name) => name.startsWith("ppt/notesSlides/notesSlide"))
    .sort(byNumericSuffix);
  for (const name of notes) {
    const body = textFromXml(textOf(members, name)).trim();
    if (body.length > 0)
      chunks.push(
        `Notes for ${name.replace(/^.*notesSlide/, "slide")}:\n${body}`,
      );
  }
  return finish(chunks.join("\n\n"), "the deck held no extractable text");
}

/** One member's bytes, or an empty string for one this extractor did not inflate. */
function textOf(members: Map<string, Buffer>, name: string): string {
  const member = members.get(name);
  return member ? member.toString("utf8") : "";
}

/** `slide10.xml` after `slide2.xml`, which is what a plain string sort gives. */
function byNumericSuffix(a: string, b: string): number {
  const left = Number.parseInt(/\d+/.exec(a)?.[0] ?? "0", 10);
  const right = Number.parseInt(/\d+/.exec(b)?.[0] ?? "0", 10);
  if (left !== right) return left - right;
  return a.localeCompare(b);
}

/** Read every member this extractor wants, in one pass over the directory. */
function readZipMembers(bytes: Buffer): Map<string, Buffer> {
  const wanted = readCentralDirectory(bytes);
  /*
   * The filter runs against the member names the directory reported, so a member that was not
   * inflated for being uninteresting is not asked for twice, and `isWanted` is the one place that
   * decides what a name may be.
   */
  return wanted;
}

function finish(text: string, emptyReason: string): ExtractedDocument {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { text: "", ok: false, reason: emptyReason };
  return { text: capExtracted(trimmed), ok: true };
}

/**
 * A PDF, which is a container of compressed page streams with its own text operators.
 *
 * A LIBRARY, AND THE OPPOSITE DECISION FROM THE XML ABOVE, and the difference is worth stating
 * because it looks inconsistent. A PDF is not a format anyone can read by regex: its text lives
 * inside streams that are Flate-compressed, the operators that place glyphs are positional, and the
 * mapping from character codes to letters is a font's business. Getting that wrong produces text
 * that is subtly wrong rather than absent, and a model will quote it. So this one is delegated.
 *
 * It is bounded rather than trusted, because `getDocument` on a hostile file is a parser and
 * parsers have been vulnerabilities before: the byte length is checked first, and a failure
 * anywhere in the call is caught and reported as "could not be read" rather than thrown into a turn
 * that is answering somebody.
 */
async function extractPdf(bytes: Buffer): Promise<ExtractedDocument> {
  try {
    /*
     * Imported here rather than at the top of the module, so a deployment that never receives a
     * PDF does not pay to load a PDF engine on its first request. `unpdf` wraps a browser PDF
     * renderer, and that is not a small thing to pull into a server that mostly answers chat.
     */
    const { extractText } = await import("unpdf");
    /*
     * `mergePages: false` so each page's text comes back separately and this file decides the
     * separator. Merged, a document with a table of contents and a document with a single page are
     * the same string with page numbers missing, and a model cannot tell them apart.
     */
    const { text } = await extractText(new Uint8Array(bytes), {
      mergePages: false,
    });
    return finish(
      text
        .map((page) => page.trim())
        .filter((page) => page.length > 0)
        .join("\n\n"),
      "the PDF held no extractable text",
    );
  } catch (error) {
    /*
     * AN ENCRYPTED PDF IS THE COMMON CASE HERE AND IS NOT AN ERROR.
     *
     * "Give me the password" is a document with a reader attached to it, and the answer a model can
     * usefully give is that the file is locked — not that the file is broken. Encrypted and damaged
     * are told apart because they want different things said about them.
     */
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(message)) {
      return {
        text: "",
        ok: false,
        reason: "the PDF is password-protected, so its text cannot be read",
      };
    }
    return {
      text: "",
      ok: false,
      reason:
        "the PDF could not be parsed (it may be damaged or in an unusual format)",
    };
  }
}

/** The three OOXML types, by the media type the upload route stored them under. */
const OOXML_READERS: Record<string, (bytes: Buffer) => ExtractedDocument> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    extractDocx,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    extractXlsx,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    extractPptx,
};

/**
 * Read a document, by the media type the upload route decided on.
 *
 * The MIME type is the STORED one, from `sniffMimeType` — earned from the bytes — and never the
 * browser's claim or the filename, so which extractor runs cannot be chosen by the uploader. See
 * the note on `resolvePart` in `attachment-parts.ts` for the case this is protecting.
 */
export async function extractDocument(
  mimeType: string,
  bytes: Uint8Array,
): Promise<ExtractedDocument> {
  if (mimeType === "application/pdf") return extractPdf(Buffer.from(bytes));

  const reader = OOXML_READERS[mimeType];
  if (reader) return reader(Buffer.from(bytes));

  return {
    text: "",
    ok: false,
    reason: "this file format has no text reader in this app",
  };
}

/** Whether a stored file has a reader at all, for the routes that promise one. */
export function canExtract(mimeType: string): boolean {
  return (
    mimeType === "application/pdf" || Object.hasOwn(OOXML_READERS, mimeType)
  );
}
