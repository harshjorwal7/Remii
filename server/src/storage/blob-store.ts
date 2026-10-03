/**
 * Where a saved file's bytes actually are.
 *
 * WHY THIS EXISTS, GIVEN THAT THE BYTES WERE ALREADY IN A DATABASE. Attachments never left
 * `bytea`, and that was a defensible choice: one backup covers everything, a transaction covers a
 * file and its row together, and there is nothing to reconcile. It stops being defensible at the
 * point where the files are larger than the database is willing to hold, where a video is 500 MB of
 * `bytea` and every backup pays for it whether or not anybody wants that video again.
 *
 * So the seam is drawn at the blob, not at the row. What stays in the database is everything a list
 * and a permission check need — the name, the type, the size, the owner, the extracted text — and
 * what moves is the bytes. A row can be read, listed, authorised and deleted without touching the
 * blob at all, which is the property that makes a driver swap a migration rather than a rewrite.
 *
 * THE INTERFACE IS DELIBERATELY NARROW. Four operations, no listing, no globbing, no copy, no
 * rename. A general object-store SDK is a large surface and this app needs four things from it; a
 * driver that grows a `list(prefix)` is a driver that will be used for something whose access rules
 * nobody has thought about, and the keys here are opaque to callers by construction.
 */

/** A blob's contents, or a slice of them. */
export type BlobSlice = {
  bytes: Uint8Array;
  /** How many bytes the blob has in total, which is not `bytes.length` for a slice. */
  totalBytes: number;
};

/** What a `put` reports back, so a row can be written without a second round trip. */
export type StoredBlob = {
  key: string;
  sizeBytes: number;
};

/**
 * A range, in the half-open form this code uses throughout.
 *
 * `endExclusive` rather than an inclusive end because a suffix range (`bytes=-500`) and an open-ended
 * one (`bytes=500-`) both have a natural exclusive bound and neither has a natural inclusive one.
 */
export type BlobRange = {
  start: number;
  endExclusive: number;
};

export type BlobStore = {
  /**
   * A key the caller can use to read the blob back.
   *
   * The store MAY choose it and the caller MUST NOT depend on its shape — a local driver returns a
   * path, an S3 driver a URL-ish string, and a test driver a counter. It is opaque for exactly that
   * reason, and a caller that parses it has coupled itself to whichever driver is configured.
   */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredBlob>;

  /**
   * The whole blob.
   *
   * THROWS when the key is unknown rather than returning null, and the reason is that every caller
   * here is answering a request for something a row says exists. A missing blob under an existing row
   * is a real fault worth surfacing — a migration that did not finish, a delete that half-worked —
   * and a `null` would turn it into a 404 that reads like "no such file", sending whoever is looking
   * for it to look in the wrong place.
   */
  get(key: string): Promise<BlobSlice>;

  /**
   * Part of a blob, for a range request.
   *
   * A driver with no real range support MAY throw, and the route treats that as "answer the whole
   * thing" rather than as a failure — a file that plays from the beginning is a worse experience but
   * not a broken one, and a driver that cannot seek should not be the reason a video will not play.
   */
  getRange(key: string, range: BlobRange): Promise<BlobSlice>;

  /**
   * Remove a blob. Must succeed on a key that is not there.
   *
   * "Must succeed" is load-bearing: a delete is called from a cleanup path that cannot distinguish
   * "gone" from "broken", and a driver that throws on a missing key turns a retried cleanup into a
   * permanent failure and leaks every remaining key behind it.
   */
  delete(key: string): Promise<void>;

  /** Whether a blob is there, for a reconciliation pass over rows whose bytes have gone missing. */
  exists(key: string): Promise<boolean>;
};

/**
 * The key a new blob is stored under.
 *
 * A function rather than a template at each call site, because the shape is what the two drivers
 * have to agree on for a migration to be possible later: whatever this produces today must still be
 * findable after the swap to S3. So it is a flat, sortable, collision-free name derived from the
 * row's own id, with no user-supplied part in it at all.
 *
 * NO USER INPUT, WHICH IS THE POINT. A key built from a filename is a key built from something a
 * person chose, and that is a path traversal (`../`), a collision (two people with `report.pdf`), or
 * both. The row id is a uuid this app minted, and the extension is carried only as a hint for
 * software that guesses types from names — never as the thing that decides one.
 */
export function artifactStorageKey(artifactId: string, name: string): string {
  const extension = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1)
    : "";
  const safeExtension = /^[a-zA-Z0-9]{1,8}$/.test(extension)
    ? extension.toLowerCase()
    : "bin";
  return `artifacts/${artifactId.slice(0, 2)}/${artifactId}.${safeExtension}`;
}

/**
 * The key an attachment is stored under.
 *
 * The same shape as {@link artifactStorageKey} and for the same reasons, with the ids separated by
 * prefix so a bucket holding both can list one without walking into the other.
 */
export function attachmentStorageKey(
  attachmentId: string,
  name: string,
): string {
  const extension = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1)
    : "";
  const safeExtension = /^[a-zA-Z0-9]{1,8}$/.test(extension)
    ? extension.toLowerCase()
    : "bin";
  return `attachments/${attachmentId.slice(0, 2)}/${attachmentId}.${safeExtension}`;
}
