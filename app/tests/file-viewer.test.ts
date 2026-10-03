import { describe, expect, test } from "bun:test";
import { isCopyable, viewerExplains, viewerFor } from "@/lib/file-viewer";

/**
 * A VIEWER IS A SWITCH WITH A WRONG DEFAULT.
 *
 * The claim worth holding is the default: whatever this function does not recognise is a download
 * and a note, never a guess. A file rendered as the wrong kind of thing is worse than a file not
 * rendered, and the types here come from the same classifier the server used to accept the upload,
 * so a file that reaches the Files page has already earned its answer.
 */
describe("viewerFor", () => {
  test("an image is drawn as an image", () => {
    expect(viewerFor("image/png")).toBe("image");
    expect(viewerFor("image/jpeg")).toBe("image");
    expect(viewerFor("image/webp")).toBe("image");
  });

  test("text is shown as text", () => {
    expect(viewerFor("text/plain")).toBe("text");
    expect(viewerFor("text/markdown")).toBe("text");
    expect(viewerFor("application/json")).toBe("text");
  });

  test("a PDF gets the browser's own viewer, and only a PDF does", () => {
    // The three OOXML formats have no browser renderer. In an iframe they are a blank page, and a
    // blank page is the worst possible answer to "open this file".
    expect(viewerFor("application/pdf")).toBe("pdf");
    expect(
      viewerFor(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("office");
    expect(
      viewerFor(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("office");
  });

  test("media is played, not drawn in a frame", () => {
    expect(viewerFor("audio/mpeg")).toBe("audio");
    expect(viewerFor("video/mp4")).toBe("video");
    expect(viewerFor("video/webm")).toBe("video");
  });

  test("anything the app cannot read is a download and a note, not a guess", () => {
    expect(viewerFor("application/zip")).toBe("download");
    expect(viewerFor("application/x-tar")).toBe("download");
    expect(viewerFor("application/octet-stream")).toBe("download");
  });

  test("a type the app refuses still does not become a viewer", () => {
    // An SVG cannot reach this page — the upload route refuses it — but a row written before that
    // rule, or a hand-edited type, must not turn into an `<img>` that executes script here.
    expect(viewerFor("image/svg+xml")).toBe("download");
    expect(viewerFor("text/html")).toBe("download");
  });

  test("no type at all is a download, and says so", () => {
    expect(viewerFor(null)).toBe("download");
    expect(viewerFor(undefined)).toBe("download");
  });
});

describe("the two notes that are not the same note", () => {
  test("an office file and an unreadable binary are told apart", () => {
    // One has a page the browser could draw if the app had a renderer; the other is bytes the app
    // cannot read at all. The same sentence for both would be wrong about one of them.
    expect(viewerExplains(viewerFor("application/zip"))).toBe(true);
    expect(
      viewerExplains(
        viewerFor(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ),
    ).toBe(true);
    expect(viewerExplains(viewerFor("image/png"))).toBe(false);
  });
});

describe("copying", () => {
  test("follows the TEXT, not the type, so a failed extraction does not offer an empty clipboard", () => {
    // A PDF whose extraction produced nothing has no text to copy, and a Copy button that empties
    // the clipboard reads as a broken button rather than as an absent one.
    expect(isCopyable("text", "anything")).toBe(true);
    expect(isCopyable("pdf", "Extracted text.")).toBe(true);
    expect(isCopyable("pdf", "")).toBe(false);
    expect(isCopyable("office", "")).toBe(false);
  });

  test("is never offered for something with no text in it at all", () => {
    expect(isCopyable("image", "")).toBe(false);
    expect(isCopyable("video", "")).toBe(false);
    expect(isCopyable("audio", "")).toBe(false);
    expect(isCopyable("download", "")).toBe(false);
  });
});
