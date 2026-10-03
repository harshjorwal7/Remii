import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BlobRange, BlobSlice, BlobStore, StoredBlob } from "./blob-store";

/**
 * Blobs on this machine's disk.
 *
 * The driver every deployment starts on, and the one the whole interface was drawn against: it is
 * the case where "where are the bytes" has an obvious answer and the only interesting question is
 * whether a key can escape the directory it is supposed to be in.
 *
 * WHICH IS THE ONE INTERESTING QUESTION, AND IT IS NOT HYPOTHETICAL. A key arrives from a database
 * row, which means it arrived from whatever wrote that row — a migration, a restore, a bug, or a
 * person with a SQL client. A key of `../../etc/passwd` read through a naive `join(root, key)` resolves
 * outside the root and this driver would hand back a system file to whoever asked, through a route
 * whose whole job is to decide who may see a file. So every key is resolved and then checked to be
 * inside the root, and a key that is not is a refusal rather than a read.
 */
export function createLocalBlobStore(rootDirectory: string): BlobStore {
  const root = resolve(rootDirectory);

  /**
   * The one place a key becomes a path, and the only place that decides whether it may.
   *
   * `resolve` collapses `..` and makes the comparison meaningful: the check afterwards is then
   * between two absolute paths rather than between a string and an intention. The separator in the
   * prefix test is what stops `/var/data-evil` passing a `startsWith("/var/data")` check.
   */
  const pathFor = (key: string): string => {
    if (key === "") throw new Error("A blob key cannot be empty.");
    if (key.startsWith("/") || key.includes("\0")) {
      throw new Error(`Refusing a blob key that is not relative: ${key}`);
    }
    const path = resolve(join(root, key));
    if (path !== root && !path.startsWith(root + sep)) {
      throw new Error(
        `Refusing a blob key that leaves the storage root: ${key}`,
      );
    }
    return path;
  };

  return {
    async put(key, bytes, _contentType): Promise<StoredBlob> {
      const path = pathFor(key);
      // Created on write rather than on construction: a store that mkdirs at startup writes to the
      // disk of a deployment that is only ever asked to read, and fails to start if that disk is
      // read-only.
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      return { key, sizeBytes: bytes.byteLength };
    },

    async get(key): Promise<BlobSlice> {
      // A `Buffer` is both array-like and iterable, so `%TypedArray%.from` over it would walk the
      // file one element at a time on the single JS thread. This is the same measurement, and the
      // same fix, as the `bytea` read in `attachments.ts`: a view, not a copy and not an iterator.
      const buffer = await readFile(pathFor(key));
      return {
        bytes: new Uint8Array(
          buffer.buffer as ArrayBuffer,
          buffer.byteOffset,
          buffer.byteLength,
        ),
        totalBytes: buffer.byteLength,
      };
    },

    async getRange(key, range: BlobRange): Promise<BlobSlice> {
      // `readFile` on its own, then a subarray: this driver keeps a file whole in memory to answer
      // any range of it, and a driver that streams is a different implementation of the same
      // interface. The contract is the contract.
      const whole = await this.get(key);
      const start = Math.max(0, Math.min(range.start, whole.totalBytes));
      const end = Math.max(
        start,
        Math.min(range.endExclusive, whole.totalBytes),
      );
      return {
        bytes: whole.bytes.subarray(start, end),
        totalBytes: whole.totalBytes,
      };
    },

    async delete(key): Promise<void> {
      // `force: true` rather than tolerating `ENOENT` in a catch: a delete that must succeed on a
      // key that is not there should not be paying for a thrown error to find that out, and a
      // cleanup loop over thousands of keys throws thousands of exceptions.
      await rm(pathFor(key), { force: true });
    },

    async exists(key): Promise<boolean> {
      try {
        const info = await stat(pathFor(key));
        return info.isFile();
      } catch {
        return false;
      }
    },
  };
}
