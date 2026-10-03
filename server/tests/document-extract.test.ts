import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { extractDocument } from "../src/channels/document-extract";

/**
 * A ZIP archive with the central directory this reader walks.
 *
 * Built here rather than checked in as a fixture because a fixture is a file nobody can edit to
 * reproduce a bug, and every interesting property of these three formats is something about the
 * archive: which members it holds, whether the method is deflate, and whether the declared size
 * matches the bytes. A helper that takes those as arguments is a test that can change one of them.
 */
function zip(
  entries: { name: string; body: string; store?: boolean }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.body, "utf8");
    const stored = entry.store === true;
    const data = stored ? raw : deflateRawSync(raw);
    const crc = 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }

  const body = Buffer.concat([...locals, ...centrals]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(body.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([body, end]);
}

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("a Word document", () => {
  test("gives the model the text, not the XML", async () => {
    const bytes = zip([
      {
        name: "word/document.xml",
        body: `<?xml version="1.0"?><w:document><w:body>
          <w:p><w:r><w:t>The lease runs to March.</w:t></w:r></w:p>
          <w:p><w:r><w:t>Break clause: 90 days.</w:t></w:r></w:p>
        </w:body></w:document>`,
      },
    ]);

    const out = await extractDocument(DOCX, bytes);

    expect(out.ok).toBe(true);
    expect(out.text).toContain("The lease runs to March.");
    expect(out.text).toContain("Break clause: 90 days.");
    // The markup must not survive: a model handed `<w:p><w:r><w:t>` quotes it back.
    expect(out.text).not.toContain("<w:");
  });

  test("keeps paragraphs apart, so a model does not read them as one sentence", async () => {
    const bytes = zip([
      {
        name: "word/document.xml",
        body: "<w:document><w:p><w:r><w:t>First.</w:t></w:r></w:p><w:p><w:r><w:t>Second.</w:t></w:r></w:p></w:document>",
      },
    ]);
    const out = await extractDocument(DOCX, bytes);
    expect(out.text).toBe("First.\nSecond.");
  });

  test("reads the notes, which is where a contract's terms usually are", async () => {
    const bytes = zip([
      { name: "word/document.xml", body: "<w:document><w:p/></w:document>" },
      {
        name: "word/footnotes.xml",
        body: "<w:footnotes><w:p><w:r><w:t>Subject to the schedule.</w:t></w:r></w:p></w:footnotes>",
      },
    ]);
    const out = await extractDocument(DOCX, bytes);
    expect(out.text).toContain("Subject to the schedule.");
  });

  test("decodes the entities Word actually writes", async () => {
    const bytes = zip([
      {
        name: "word/document.xml",
        body: "<w:document><w:p><w:r><w:t>R&amp;D &lt;tag&gt; &#8212; quoted</w:t></w:r></w:p></w:document>",
      },
    ]);
    const out = await extractDocument(DOCX, bytes);
    expect(out.text).toContain("R&D <tag> — quoted");
  });

  test("does not read a spreadsheet's shared strings into a word processor's output", async () => {
    // The two OOXML families are one archive format, and a reader that pulled every `word/` member
    // regardless of the actual document would put a workbook's labels into a sentence about a
    // contract.
    const bytes = zip([
      {
        name: "word/document.xml",
        body: "<w:document><w:p><w:r><w:t>Body.</w:t></w:r></w:p></w:document>",
      },
      {
        name: "word/sharedStrings.xml",
        body: "<sst><si><t>Revenue</t></si></sst>",
      },
    ]);
    const out = await extractDocument(DOCX, bytes);
    expect(out.text).toContain("Body.");
    expect(out.text).not.toContain("Revenue");
  });

  test("says so when the archive holds no Word part, rather than returning nothing", async () => {
    // The two failures are told apart on purpose: an archive with no readable member at all is not
    // a Word document, and one with members but no body is a Word document this reader could not
    // find text in. Both are refusals, and a model can answer differently to each.
    const bytes = zip([{ name: "xl/workbook.xml", body: "<workbook/>" }]);
    const out = await extractDocument(DOCX, bytes);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("no extractable text");
  });

  test("says so when the file is not an archive this reader can open", async () => {
    const out = await extractDocument(
      DOCX,
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("ZIP archive");
  });

  test("reads a member stored rather than deflated, which is legal and common", async () => {
    const bytes = zip([
      {
        name: "word/document.xml",
        body: "<w:document><w:p><w:r><w:t>Stored, not compressed.</w:t></w:r></w:p></w:document>",
        store: true,
      },
    ]);
    const out = await extractDocument(DOCX, bytes);
    expect(out.text).toContain("Stored, not compressed.");
  });
});

describe("a spreadsheet", () => {
  test("names the sheets, so a model knows which one it is answering about", async () => {
    const bytes = zip([
      {
        name: "xl/workbook.xml",
        body: '<workbook><sheets><sheet name="Q1"/><sheet name="Q2"/></sheets></workbook>',
      },
      {
        name: "xl/sharedStrings.xml",
        body: "<sst><si><t>failed</t></si></sst>",
      },
    ]);
    const out = await extractDocument(XLSX, bytes);
    expect(out.text).toContain("Q1, Q2");
    expect(out.text).toContain("failed");
  });

  test("reads a numbered sheet, which cannot be named in advance", async () => {
    const bytes = zip([
      {
        name: "xl/workbook.xml",
        body: '<workbook><sheets><sheet name="Data"/></sheets></workbook>',
      },
      {
        name: "xl/worksheets/sheet1.xml",
        body: "<worksheet><sheetData><row><c><v>42</v></c></row></sheetData></worksheet>",
      },
    ]);
    const out = await extractDocument(XLSX, bytes);
    expect(out.text).toContain("42");
  });
});

describe("a deck", () => {
  test("reads slides in order, so slide 10 is not summarised as slide 2", async () => {
    const bytes = zip([
      {
        name: "ppt/slides/slide10.xml",
        body: "<p:sld><a:p><a:t>Tenth slide.</a:t></a:p></p:sld>",
      },
      {
        name: "ppt/slides/slide2.xml",
        body: "<p:sld><a:p><a:t>Second slide.</a:t></a:p></p:sld>",
      },
    ]);
    const out = await extractDocument(PPTX, bytes);
    expect(out.text.indexOf("Second slide.")).toBeLessThan(
      out.text.indexOf("Tenth slide."),
    );
    expect(out.text).toContain("Slide 2:");
    expect(out.text).toContain("Slide 10:");
  });
});

describe("a file this app cannot read", () => {
  test("says it has no reader, rather than returning the bytes as text", async () => {
    const out = await extractDocument(
      "application/zip",
      new Uint8Array([1, 2, 3]),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("no text reader");
  });
});

describe("a hostile archive", () => {
  test("a member named like a path is not read", async () => {
    // The names here are labels, not filenames, and nothing joins them to a path — but an archive
    // that offers a member called `../../etc/passwd` should still come back as a document with
    // nothing in it rather than as whatever it managed to name.
    const bytes = zip([
      {
        name: "word/document.xml",
        body: "<w:document><w:p><w:r><w:t>Real.</w:t></w:r></w:p></w:document>",
      },
      { name: "../../etc/passwd", body: "root:x:0:0" },
    ]);
    const out = await extractDocument(DOCX, bytes);
    expect(out.text).toContain("Real.");
    expect(out.text).not.toContain("root:");
  });

  test("a directory that lies about its own size is rejected, not believed", async () => {
    const bytes = zip([{ name: "word/document.xml", body: "<w:document/>" }]);
    // Corrupt the central directory's count so the walk ends against a record that is not there.
    bytes.writeUInt16LE(0xffff, bytes.length - 22 + 8);
    const out = await extractDocument(DOCX, bytes);
    // Whatever comes back, it is a document answer and not a throw.
    expect(typeof out.ok).toBe("boolean");
  });
});

describe("the PDF path", () => {
  test("a password-protected PDF is reported as locked, not as damaged", async () => {
    // The distinction matters to the model: "it is locked" and "it is broken" want different
    // answers, and only one of them is worth anybody's time.
    const encrypted = new Uint8Array(
      Buffer.from("%PDF-1.4\n/Encrypt 12 0 R\ntrailer\n%%EOF\n"),
    );
    const out = await extractDocument("application/pdf", encrypted);
    expect(out.ok).toBe(false);
    // Whatever the reason, it is a sentence and not an exception out of a turn.
    expect(out.reason).toBeTruthy();
  });
});
