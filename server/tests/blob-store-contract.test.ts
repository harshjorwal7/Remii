import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactStorageKey,
  attachmentStorageKey,
  type BlobStore,
} from "../src/storage/blob-store";
import { createLocalBlobStore } from "../src/storage/local-blob-store";

/**
 * THE CONTRACT, RUN AGAINST EVERY DRIVER.
 *
 * An interface with one implementation is not an interface, it is a class — and the S3 driver has
 * never been run against a bucket, so it is the local driver that proves the contract is even
 * writeable. This is that proof, and it is written as a function rather than a `describe` so a
 * second driver is one call away.
 *
 * The AWS SDK's own behaviour is NOT tested here. Slicing a local file and asking S3 for a range are
 * different code paths, and what they have in common is the four operations and the failure modes
 * below — so testing the SDK would be testing the SDK, and would need a bucket to do it. What is
 * tested of the S3 driver directly is the part that is this app's own: {@link s3Config} refusing a
 * half-configured deployment, which is the failure that would otherwise be discovered on somebody's
 * first upload.
 */

export function contractTests(
  name: string,
  build: () => Promise<{ store: BlobStore; cleanup: () => Promise<void> }>,
) {
  describe(`the blob store contract, as ${name} implements it`, () => {
    let store: BlobStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const built = await build();
      store = built.store;
      cleanup = built.cleanup;
    });
    afterEach(async () => cleanup());

    it("reads back exactly what was written", async () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 0, 0]);
      await store.put("contract/exact.bin", bytes, "application/octet-stream");

      const read = await store.get("contract/exact.bin");

      expect([...read.bytes]).toEqual([...bytes]);
      expect(read.totalBytes).toBe(bytes.byteLength);
    });

    it("writes an empty blob and reads it back as empty, rather than as missing", async () => {
      // A zero-byte file is a real thing somebody attaches, and "empty" and "not there" are
      // different answers: one renders as a file with nothing in it, the other as a 404.
      await store.put("contract/empty.bin", new Uint8Array(0), "text/plain");

      const read = await store.get("contract/empty.bin");

      expect(read.bytes.byteLength).toBe(0);
      expect(read.totalBytes).toBe(0);
    });

    it("reports the size it was given, and it is the size it stores", async () => {
      const bytes = new Uint8Array(1024).fill(7);
      const stored = await store.put(
        "contract/sized.bin",
        bytes,
        "application/octet-stream",
      );

      expect(stored.sizeBytes).toBe(1024);
      expect((await store.get("contract/sized.bin")).totalBytes).toBe(1024);
    });

    it("overwrites rather than appending, because a key names a version and not a log", async () => {
      await store.put(
        "contract/replaced.bin",
        new Uint8Array([1, 1, 1]),
        "text/plain",
      );
      await store.put(
        "contract/replaced.bin",
        new Uint8Array([2]),
        "text/plain",
      );

      const read = await store.get("contract/replaced.bin");

      expect([...read.bytes]).toEqual([2]);
    });

    it("gives back a middle range, and nothing else", async () => {
      await store.put(
        "contract/ranged.bin",
        new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
        "application/octet-stream",
      );

      const read = await store.getRange("contract/ranged.bin", {
        start: 3,
        endExclusive: 6,
      });

      expect([...read.bytes]).toEqual([3, 4, 5]);
      // The TOTAL, not the slice's length — which is what a media element builds its seek bar from.
      expect(read.totalBytes).toBe(10);
    });

    it("clamps a range that runs past the end, because most clients do not know the size", async () => {
      await store.put(
        "contract/short.bin",
        new Uint8Array([0, 1, 2]),
        "text/plain",
      );

      const read = await store.getRange("contract/short.bin", {
        start: 1,
        endExclusive: 9999,
      });

      expect([...read.bytes]).toEqual([1, 2]);
      expect(read.totalBytes).toBe(3);
    });

    it("gives an empty range rather than throwing when asked for nothing", async () => {
      await store.put(
        "contract/nothing.bin",
        new Uint8Array([0, 1, 2]),
        "text/plain",
      );

      const read = await store.getRange("contract/nothing.bin", {
        start: 1,
        endExclusive: 1,
      });

      expect(read.bytes.byteLength).toBe(0);
    });

    it("deletes, and deleting again succeeds rather than throwing", async () => {
      /*
       * THE SECOND DELETE IS THE TEST. A cleanup pass over a thousand keys calls delete on every one
       * of them, and a driver that throws on a key that is not there turns a retried cleanup into a
       * permanent failure and leaks everything behind the one that threw.
       */
      await store.put("contract/gone.bin", new Uint8Array([1]), "text/plain");
      await store.delete("contract/gone.bin");
      await store.delete("contract/gone.bin");

      expect(await store.exists("contract/gone.bin")).toBe(false);
    });

    it("deletes a key that was never written, without complaint", async () => {
      await store.delete("contract/never-existed.bin");
    });

    it("reports existence, and absence, honestly", async () => {
      await store.put("contract/here.bin", new Uint8Array([1]), "text/plain");

      expect(await store.exists("contract/here.bin")).toBe(true);
      expect(await store.exists("contract/elsewhere.bin")).toBe(false);
    });

    it("keeps two keys apart", async () => {
      await store.put("contract/a.bin", new Uint8Array([1]), "text/plain");
      await store.put("contract/b.bin", new Uint8Array([2]), "text/plain");

      expect([...(await store.get("contract/a.bin")).bytes]).toEqual([1]);
      expect([...(await store.get("contract/b.bin")).bytes]).toEqual([2]);
    });

    it("refuses a key that tries to leave the store", async () => {
      /*
       * THE KEY IS NOT A FILENAME AND MUST NOT BE TREATED AS ONE.
       *
       * A key arrives from a database row, so it arrived from whatever wrote that row. A driver
       * that resolves `../` and reads the result would hand back a file outside the store through a
       * route whose entire job is deciding who may read what. Both directions are refused, and a
       * refusal is better here than an empty read: an empty read looks like a missing file and sends
       * whoever is looking for it to look in the wrong place.
       */
      await expect(store.get("../../../../etc/passwd")).rejects.toThrow();
      await expect(store.get("/etc/passwd")).rejects.toThrow();
    });
  });
}

contractTests("the local driver", async () => {
  const root = await mkdtemp(join(tmpdir(), "remii-blobs-"));
  return {
    store: createLocalBlobStore(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

describe("storage keys", () => {
  it("are derived from the row's own id, never from a filename", () => {
    // A key built from a name is a key built from something a person chose, which is a traversal
    // and a collision. The id is a uuid this app minted; the extension is only a hint.
    expect(
      artifactStorageKey("0f1e2d3c-4b5a-6789-abcd-ef0123456789", "report.pdf"),
    ).toBe("artifacts/0f/0f1e2d3c-4b5a-6789-abcd-ef0123456789.pdf");
  });

  it("fall back to a neutral extension rather than carrying a strange one through", () => {
    expect(
      artifactStorageKey("0f1e2d3c-4b5a-6789-abcd-ef0123456789", "notes"),
    ).toBe("artifacts/0f/0f1e2d3c-4b5a-6789-abcd-ef0123456789.bin");
    // A long or non-alphanumeric "extension" is not one, and is not written into a key that software
    // guesses types from.
    expect(artifactStorageKey("abc", "file.this-is-not-an-extension")).toBe(
      "artifacts/ab/abc.bin",
    );
  });

  it("keep artifacts and attachments in separate prefixes", () => {
    // So a bucket holding both can be listed one at a time, and so a key from one can never be
    // mistaken for a key from the other.
    expect(
      attachmentStorageKey("0f1e2d3c-4b5a-6789-abcd-ef0123456789", "photo.png"),
    ).toBe("attachments/0f/0f1e2d3c-4b5a-6789-abcd-ef0123456789.png");
  });
});
