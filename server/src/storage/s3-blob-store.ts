import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { BlobRange, BlobSlice, BlobStore, StoredBlob } from "./blob-store";

/**
 * Blobs in an S3 bucket.
 *
 * EXISTS AND IS NOT WIRED IN, and the reason is worth stating before anything else: this driver has
 * never been run against a bucket. There is no bucket, no credentials and no region behind it —
 * `S3Config` below validates the shape of a configuration, not the reachability of one. It is here
 * so the interface was drawn against two implementations rather than one, because an interface with
 * a single implementation is not an interface, it is a class.
 *
 * WHAT IS ACTUALLY TESTED HERE IS THE PART THAT DOES NOT NEED A BUCKET: the key handling, the range
 * arithmetic, the config validation, and the refusal to start on a half-configured deployment. The
 * calls themselves are the SDK's, and {@link contractTests} says so by skipping them rather than
 * pretending.
 *
 * WHY BYTES ARE PROXIED RATHER THAN PRESIGNED. A presigned URL hands the bytes to the browser
 * directly, which is cheaper and offloads this process — and which also means the bucket has to be
 * publicly readable by anyone holding the link for an hour, with no way to check whether the person
 * asking was ever a member of the channel the file was sent in. A signed URL is a bearer token, and
 * this app's whole access story is "re-decided on every fetch against current membership". Proxying
 * keeps that answer where it is. The cost is real and is the tradeoff being made knowingly: this
 * process moves every byte.
 */
export type S3Config = {
  bucket: string;
  region: string;
  /** Absent means the SDK's own chain: env, shared config, instance role. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Where to send SDK logs and how hard to try. `forcePathStyle` matters for MinIO and for a
   * bucket name that is not DNS-legal, which is every bucket name a test uses. */
  endpoint?: string;
  forcePathStyle?: boolean;
};

export function createS3BlobStore(config: S3Config): BlobStore {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(config.accessKeyId && config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }
      : {}),
  });

  /**
   * The body of a `GetObject` as bytes.
   *
   * A node `GetObject` stream has to be drained by hand, and this is the whole of that: collect the
   * chunks and concatenate. `transformToByteArray` is the SDK's own version of the same loop and is
   * what this would otherwise be written by hand, so it is used instead — with one thing added
   * around it, which is that a body arriving as a stream rather than as bytes is a shape the rest
   * of this app never handles, and a `Uint8Array` is the only shape it does.
   */
  const bytesOf = async (body: unknown): Promise<Uint8Array> => {
    if (body instanceof Uint8Array) return body;
    const withHelper = body as {
      transformToByteArray?: () => Promise<Uint8Array>;
    };
    if (typeof withHelper?.transformToByteArray !== "function") {
      throw new Error("S3 returned a body this driver cannot read as bytes.");
    }
    return withHelper.transformToByteArray();
  };

  return {
    async put(key, bytes, contentType): Promise<StoredBlob> {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: bytes,
          /*
           * THE STORED TYPE, SET ON THE OBJECT AND NOT INFERRED LATER.
           *
           * Two reasons, and the second is the one that matters. First, an S3 object with no content
           * type is served by anything downstream that reads it as `application/octet-stream`, which
           * is the generic name this app uses for "just bytes" — so a text file would come back
           * typed as binary and a browser would download it. Second, and worse: a PDF's own type is
           * what makes a browser run a PDF viewer, and an object stored without one can be served
           * under any type at all by whatever fetches it. The type is decided by the sniffer at
           * upload and written once, here.
           *
           * Server-side encryption is set because the bucket may not have a default and the failure
           * mode of a bucket without one is a stored file nobody thought about.
           */
          ContentType: contentType,
          ServerSideEncryption: "AES256",
        }),
      );
      return { key, sizeBytes: bytes.byteLength };
    },

    async get(key): Promise<BlobSlice> {
      const response = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      const bytes = await bytesOf(response.Body);
      return { bytes, totalBytes: bytes.byteLength };
    },

    async getRange(key, range: BlobRange): Promise<BlobSlice> {
      /*
       * THE TOTAL COMES FROM `ContentRange`, AND THAT IS THE WHOLE REASON THIS IS NOT A SLICE.
       *
       * A 206 response carries the blob's full length in `Content-Range` ("bytes 2-5/10") and nothing
       * else says it. Reading a local file and slicing it gets the total for free from the file
       * itself; from S3 the only statement of the file's size is in that header, and a driver that
       * answered a range with the slice's own length would tell every media element the file is as
       * long as the piece it was handed — so a seek bar would be built out of the wrong number.
       */
      const response = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Range: `bytes=${range.start}-${Math.max(range.start, range.endExclusive - 1)}`,
        }),
      );
      const bytes = await bytesOf(response.Body);
      const contentRange = response.ContentRange ?? "";
      const total = Number.parseInt(contentRange.split("/")[1] ?? "", 10);
      return {
        bytes,
        totalBytes:
          Number.isFinite(total) && total > 0 ? total : bytes.byteLength,
      };
    },

    async delete(key): Promise<void> {
      // S3's delete is already idempotent — deleting a key that is not there succeeds — so there is
      // no existence check to make, and making one would be a round trip per key in a cleanup loop.
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    },

    async exists(key): Promise<boolean> {
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return true;
      } catch {
        // A 404 and a 403 are both "not readable as this key", and the caller's question is whether
        // it can be read at all.
        return false;
      }
    },
  };
}
