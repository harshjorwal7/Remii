import { describe, expect, test } from "bun:test";
import { classifyAttachment, maxBytesForKind } from "../../shared/attachments";
import { sniffMimeType } from "../src/channels/attachment-mime";

/**
 * THE NEW FAMILIES, NAMED FROM THEIR BYTES.
 *
 * The tests that were already here all earn an image type from a signature, and this file is the
 * same discipline applied to the formats that were added: a PDF, a ZIP and its three OOXML
 * shapes, a few media containers, and — the part that matters most — the files that are NOT what
 * they claim.
 *
 * The last group is the important one. "Accept any file" is only safe because the type served is the
 * type earned from the content, and a test that only checked the happy path would pass just as
 * happily with a sniffer that returned the claim.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ascii = (text: string) => new TextEncoder().encode(text);

describe("containers named from their bytes", () => {
  test("a PDF is a PDF, whatever anybody called it", () => {
    expect(sniffMimeType(ascii("%PDF-1.7\n1 0 obj\n"), "")).toBe(
      "application/pdf",
    );
    // A file that CLAIMS to be a PDF and is one is still a PDF.
    expect(sniffMimeType(ascii("%PDF-1.4\n"), "application/octet-stream")).toBe(
      "application/pdf",
    );
  });

  test("a zip is a zip, and is not promoted to a Word document because the browser said so", () => {
    // THE CASE THIS IS ABOUT. `.docx`, `.xlsx` and `.pptx` are all one ZIP, and the only part of
    // the file that says which is the directory at the END. This sniffer does not read directories,
    // so it must not name a format it has not seen — and a zip is `binary`, which is stored and
    // handed back whole rather than handed to a Word renderer.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    expect(sniffMimeType(zip, "")).toBe("application/zip");
  });

  test("a zip claimed as an OOXML format keeps the claim, because bytes and claim agree", () => {
    // The one place the claim IS trusted: the bytes say ZIP, the claim says which of the three
    // things inside it, and neither contradicts the other. This is also the only way a `.docx`
    // becomes a document at all.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    expect(
      sniffMimeType(
        zip,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  test("an empty zip is a zip, and does not become text", () => {
    // `PK\x05\x06` is the empty-archive signature and is not a document. Left unrecognised it would
    // fall through to the UTF-8 guess and be stored as prose.
    expect(
      sniffMimeType(new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]), ""),
    ).toBe("application/zip");
  });

  test("the pre-2007 Office container is a binary, not a Word file this app cannot read", () => {
    // One OLE2 container behind `.doc`, `.xls` and `.ppt`. Naming one of the three would put a
    // file in front of an extractor this app does not have, and the extractor would report an empty
    // document rather than an unreadable one.
    expect(
      sniffMimeType(
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        "application/msword",
      ),
    ).toBe("application/x-ole-storage");
  });

  test("compressed streams and archives are named, so they are never mistaken for text", () => {
    expect(sniffMimeType(new Uint8Array([0x1f, 0x8b, 0x08]), "")).toBe(
      "application/gzip",
    );
    expect(sniffMimeType(ascii("BZh9AY&SY"), "")).toBe("application/x-bzip2");
    expect(
      sniffMimeType(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), ""),
    ).toBe("application/x-7z-compressed");
  });

  test("an ISO base media file is named audio or video by agreement, and video by default", () => {
    const mp4 = ascii("....ftypisom");
    expect(sniffMimeType(mp4, "video/mp4")).toBe("video/mp4");
    // The four bytes do not distinguish an .m4a from an .mp4, so the claim picks the track and a
    // missing or wrong claim gets the video name — which is `binary` either way, so the failure is
    // a file stored whole and never a file played as the wrong thing.
    expect(sniffMimeType(mp4, "audio/mp4")).toBe("audio/mp4");
    expect(sniffMimeType(mp4, "")).toBe("video/mp4");
  });

  test("WAV is audio and a TIFF is an image, which are different verdicts on similar bytes", () => {
    expect(sniffMimeType(ascii("RIFF....WAVEfmt "), "")).toBe("audio/wav");
    expect(sniffMimeType(new Uint8Array([0x49, 0x49, 0x2a, 0x00]), "")).toBe(
      "image/tiff",
    );
  });

  test("an Ogg container is not told which codec it holds", () => {
    const ogg = ascii("OggS....");
    expect(sniffMimeType(ogg, "audio/ogg")).toBe("audio/ogg");
    expect(sniffMimeType(ogg, "")).toBe("application/ogg");
  });
});

describe("files that are not what they claim", () => {
  test("arbitrary bytes claiming to be a PDF are NOT served as a PDF", () => {
    /*
     * THE SAME RULE IMAGES HAVE HAD ALL ALONG, NOW APPLIED TO DOCUMENTS.
     *
     * Reaching the accepted-document list with bytes that did not name a container means the file
     * is not that format. Returning the claim would store it and serve it from this origin as
     * `application/pdf`, and a `Content-Type` is a request that a client trust the type — so this
     * app would be standing behind a header it knows to be false.
     */
    const lying = sniffMimeType(ascii("not a pdf at all"), "application/pdf");
    expect(lying).toBe("application/octet-stream");
    /*
     * REFUSED, NOT KEPT AS A BINARY — and deliberately the same answer a fake PNG gets.
     *
     * The distinction that matters: a file claiming a type this app has NEVER HEARD OF keeps its
     * own type and is stored, because a file it cannot read is still a file it can hand back
     * whole. A file claiming a type this app PROMISED a viewer for had better be one, or the
     * alternative is a client choosing the `Content-Type` its own bytes will be served under and a
     * viewer being handed something that is not what it parses.
     */
    expect(classifyAttachment(lying)).toBe("unsupported");
  });

  test("arbitrary bytes claiming to be audio are not served as audio", () => {
    expect(sniffMimeType(ascii("just some words"), "audio/mpeg")).toBe(
      "application/octet-stream",
    );
  });

  test("a real PDF claiming to be audio is still a PDF, because the bytes outrank the claim", () => {
    expect(sniffMimeType(ascii("%PDF-1.7\n"), "audio/mpeg")).toBe(
      "application/pdf",
    );
  });

  test("markup that a browser would execute is still refused after all this", () => {
    // The whole reason the accepted list can stop being a refusal list. A file the app does not
    // know is `binary`; a file the app would EXECUTE is not.
    const html = sniffMimeType(ascii("<script>alert(1)</script>"), "text/html");
    expect(classifyAttachment(html)).toBe("unsupported");

    const svg = sniffMimeType(
      ascii("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      "image/svg+xml",
    );
    expect(classifyAttachment(svg)).toBe("unsupported-image");
  });

  test("an empty file is still refused, whatever it claims", () => {
    expect(
      classifyAttachment(sniffMimeType(new Uint8Array(0), "text/plain")),
    ).toBe("unsupported");
  });
});

describe("what each kind means for the person who attached the file", () => {
  test("the four previewable families and the download one are told apart", () => {
    expect(classifyAttachment("image/png")).toBe("image");
    expect(classifyAttachment("text/plain")).toBe("text");
    expect(classifyAttachment("application/pdf")).toBe("document");
    expect(classifyAttachment("audio/mpeg")).toBe("audio");
    expect(classifyAttachment("video/mp4")).toBe("video");
    expect(classifyAttachment("application/zip")).toBe("binary");
  });

  test("each family has its own ceiling, and the numbers are not interchangeable", () => {
    // A document is bound by an extractor's memory, a media file by nothing but the disk, and an
    // image by a provider's vision limit. One constant for all three would either refuse files the
    // app can read or accept ones a provider will not take.
    const limits = [
      classifyAttachment("image/png"),
      classifyAttachment("text/plain"),
      classifyAttachment("application/pdf"),
      classifyAttachment("video/mp4"),
      classifyAttachment("application/zip"),
    ].map((kind) => maxBytesForKind(kind));
    expect(new Set(limits).size).toBe(5);
  });
});
