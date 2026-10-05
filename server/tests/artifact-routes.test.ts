import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createRemiRoutes } from "../src/remi/routes";
import { createLocalBlobStore } from "../src/storage/local-blob-store";
import type { AppVariables } from "../src/auth/guards";
import type { Database } from "../src/db/client";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { users } from "../src/db/schema";
import { eq } from "drizzle-orm";

/**
 * THE TWO DOORS ON THE FILES PAGE.
 *
 * `POST /api/remi/artifacts` is a person picking a file off their own disk — the door that did not
 * exist before, and the reason this page is now a place somebody can put their own documents rather
 * than only somewhere they can find what a model decided to keep. `GET .../content` is the bytes,
 * which the detail query cannot carry because it is capped at 100,000 characters of extracted text.
 *
 * THE PROPERTIES THAT MATTER ARE ABOUT TRUST, NOT ABOUT STATUS CODES. A file that the upload route
 * would refuse as a message attachment is refused here, with the same reason, because the same
 * sniffer and the same classifier decide. And the content route re-decides ownership on every fetch
 * rather than handing out a link.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);
const OWNER = "artifact-routes-owner";
const STRANGER = "artifact-routes-stranger";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "remii-artifacts-"));
  /*
   * The two people this file uses. `artifacts.user_id` has a foreign key into `users`, so a test
   * that invents an id fails on the insert rather than on the thing it means to check — and the
   * stranger is not optional, because "one person's file is nobody else's" is half the file.
   */
  await database
    .insert(users)
    .values(
      [OWNER, STRANGER].map((id) => ({
        id,
        email: `${id}-${randomUUID()}@example.test`,
      })),
    )
    .onConflictDoNothing();
  createdUserIds.push(OWNER, STRANGER);
});

const createdUserIds: string[] = [];

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  // Cascades the artifacts these tests wrote.
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

/** A server with one person signed in, and a real blob store behind it. */
function appFor(userId: string) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", async (context, next) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.test`,
    } as never);
    await next();
  });
  routes.route(
    "/",
    createRemiRoutes({
      database,
      requireUser: async (_context, next) => next(),
      blobs: createLocalBlobStore(root),
    }),
  );
  return routes;
}

function uploadForm(file: File) {
  const form = new FormData();
  form.set("file", file);
  return form;
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

describe("uploading a file to the Files page", () => {
  test("a file whose type the app cannot read is stored anyway, and named as itself", async () => {
    /*
     * THE POINT OF THE DOOR. A `.zip` has no text and no preview and the app cannot read it, and it
     * is still a file somebody chose to keep — refusing it would make the page a place you can only
     * put things the app happens to understand.
     */
    const app = appFor(OWNER);
    const zip = new File(
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])],
      "a.zip",
      {
        type: "application/zip",
      },
    );

    const response = await app.request("http://test/artifacts", {
      method: "POST",
      body: uploadForm(zip),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { artifact: { mimeType: string } };
    expect(body.artifact.mimeType).toBe("application/zip");
  });

  test("markup a browser would execute is refused, with the same reason the message route gives", async () => {
    const app = appFor(OWNER);
    const html = new File(["<script>alert(1)</script>"], "page.html", {
      type: "text/html",
    });

    const response = await app.request("http://test/artifacts", {
      method: "POST",
      body: uploadForm(html),
    });

    // The upload route and this one share `classifyAttachment`, so a file refused as a message is
    // refused here — a second set of rules for the same bytes would be a way around the first.
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("text/html");
  });

  test("bytes that lie about being a PDF are refused, exactly as a fake image is", async () => {
    const app = appFor(OWNER);
    const fake = new File(["not a pdf"], "report.pdf", {
      type: "application/pdf",
    });

    const response = await app.request("http://test/artifacts", {
      method: "POST",
      body: uploadForm(fake),
    });

    expect(response.status).toBe(415);
  });

  test("the stored type comes from the bytes, not from what the browser called the file", async () => {
    // A `.txt` that is really a PNG: the sniffer names it, so it is drawn as an image later. Trusting
    // `file.type` here is how a binary ends up served as prose.
    const app = appFor(OWNER);
    const mislabelled = new File([PNG], "photo.txt", { type: "text/plain" });

    const response = await app.request("http://test/artifacts", {
      method: "POST",
      body: uploadForm(mislabelled),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { artifact: { mimeType: string } };
    expect(body.artifact.mimeType).toBe("image/png");
  });

  test("a request with no file is refused in a sentence", async () => {
    const app = appFor(OWNER);
    const form = new FormData();
    form.set("something", "else");

    const response = await app.request("http://test/artifacts", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("No file");
  });
});

describe("reading a file's bytes back", () => {
  async function upload(app: Hono<{ Variables: AppVariables }>, file: File) {
    const response = await app.request("http://test/artifacts", {
      method: "POST",
      body: uploadForm(file),
    });
    const body = (await response.json()) as { artifact: { id: string } };
    return body.artifact.id;
  }

  test("the bytes come back exactly as they went in", async () => {
    const app = appFor(OWNER);
    const id = await upload(
      app,
      new File([PNG], "photo.png", { type: "image/png" }),
    );

    const response = await app.request(`http://test/artifacts/${id}/content`);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("a range is answered with 206, which is what makes a video seekable", async () => {
    const app = appFor(OWNER);
    /*
     * REAL `ftyp` BYTES, because a file that CLAIMS to be an MP4 and is not one is refused — the
     * same rule a fake PNG is. A body of ten arbitrary bytes would be testing that refusal instead
     * of the range.
     */
    // `ftyp` sits at offset 4 in a real ISO base media file, and the sniffer looks there.
    const bytes = new TextEncoder()
      .encode("\u0000\u0000\u0000\u0020ftypisom")
      .subarray(0, 10);
    const id = await upload(
      app,
      new File([bytes], "clip.mp4", { type: "video/mp4" }),
    );

    const response = await app.request(`http://test/artifacts/${id}/content`, {
      headers: { Range: "bytes=2-5" },
    });

    expect(response.status).toBe(206);
    // The four bytes at offsets 2..5 of THIS file, which is an `ftyp` header and therefore not the
    // 0,1,2,3,4 a reader might assume. The point is the offsets, not the values.
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      ...bytes.subarray(2, 6),
    ]);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
  });

  test("one person's file is nobody else's, and says so in a way that does not confirm it exists", async () => {
    const app = appFor(OWNER);
    const id = await upload(
      app,
      new File([PNG], "private.png", { type: "image/png" }),
    );

    const response = await appFor(STRANGER).request(
      `http://test/artifacts/${id}/content`,
    );

    // 404 and not 403: a 403 confirms the id is real, and the id is a uuid a person can be handed.
    expect(response.status).toBe(404);
  });

  test("the filename rides along, escaped, because a person saving a file needs its name", async () => {
    const app = appFor(OWNER);
    const id = await upload(
      app,
      new File([PNG], "quarterly report.png", { type: "image/png" }),
    );

    const response = await app.request(`http://test/artifacts/${id}/content`);

    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("inline");
    expect(disposition).toContain("filename=");
    // And the raw name is not pasted in raw: it went through the same escaper the attachment route
    // uses, and a name with a quote or a newline in it cannot break the header.
    expect(disposition).not.toContain("\n");
  });

  test("a row whose bytes have gone says 410, because 'no such file' would be a lie they act on", async () => {
    const app = appFor(OWNER);
    const id = await upload(
      app,
      new File([PNG], "gone.png", { type: "image/png" }),
    );
    // Somebody emptied the storage root behind the app's back.
    await rm(root, { recursive: true, force: true });

    const response = await app.request(`http://test/artifacts/${id}/content`);

    // The row is there and the owner is right, so "no such file" would send them to look for a
    // deletion that never happened. The truth is a storage fault, and it is worth saying so.
    expect(response.status).toBe(410);
  });
});
