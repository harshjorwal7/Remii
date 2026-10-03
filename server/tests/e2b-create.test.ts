import { describe, expect, test } from "bun:test";
import {
  DESKTOP_RESOLUTION,
  NOVNC_PORT,
  VNC_PORT,
  metadataFor,
  sandboxKeyFor,
  volumeNameFor,
} from "../src/computer/e2b-sdk";

/**
 * How a person is identified on E2B, and why none of it is their user id.
 *
 * These are the two strings a person owns — the metadata key that finds their desktop again if the
 * database row is lost, and the volume name that finds their files. Both appear in E2B's dashboard,
 * in API responses, and in anything that logs a sandbox or volume list.
 *
 * The properties asserted here are the ones whose loss is expensive and invisible. A name that leaks a
 * user id is a privacy problem that nobody notices. A name that is not RECOMPUTABLE is an orphaned
 * paid desktop and an orphaned volume of somebody's files, discovered when they complain. A name that
 * is not STABLE is two desktops and two volumes for one person, billed twice.
 */

/** Distinct, realistic user ids — E2B and this codebase both use prefixed opaque ids. */
const IDS = [
  "user_2f9a1c4e8b7d",
  "user_3a8b2c5d9e8f",
  "user_4b9c3d6e0f9a",
  "user_5cad4e7f1a0b",
  "user_6dbe5f80a2b1c",
];

describe("the opaque key identifying a person's computer", () => {
  test("is stable, so a lost row still finds its machine", () => {
    // This is the whole reason the key is a hash of the user id rather than something stored. The
    // provisioner lists sandboxes by this metadata to adopt an existing desktop instead of paying for
    // a second one, and that lookup only works if the same id always produces the same key.
    for (const id of IDS) {
      expect(sandboxKeyFor(id)).toBe(sandboxKeyFor(id));
    }
  });

  test("differs for every distinct person", () => {
    // A collision here is one person being handed another person's desktop: their files, their
    // logins, their screen. There is no second line of defence on this path.
    expect(new Set(IDS.map(sandboxKeyFor)).size).toBe(IDS.length);
  });

  test("never contains the user id", () => {
    // These strings are visible to an operator holding a sandbox. A name reading as somebody's own id
    // tells that operator which database row a machine belongs to without the server looking anything
    // up, and a dashboard is not the place to discover who somebody is.
    for (const id of IDS) {
      expect(sandboxKeyFor(id)).not.toContain(id);
    }
  });

  test("is safe as an E2B name for ids that slug away to nothing", () => {
    // E2B rejects names with no alphanumeric content, so a slug that is empty or entirely punctuation
    // has to fall back rather than produce `remii-user-`, which every such person would then share.
    for (const id of ["", "!!!", "---", "   "]) {
      const key = sandboxKeyFor(id);
      expect(key).toMatch(/[a-z0-9]/i);
      expect(key.length).toBeGreaterThan(1);
    }
    // Distinct even when the slugs collide, because the hash is on the whole id.
    expect(sandboxKeyFor("!!!")).not.toBe(sandboxKeyFor("???"));
  });

  test("handles ids far longer than the slug it keeps", () => {
    // The slug is truncated so names stay readable; the hash covers the whole id, so truncation cannot
    // make two long ids collide.
    const base = "u".repeat(400);
    expect(sandboxKeyFor(`${base}a`)).not.toBe(sandboxKeyFor(`${base}b`));
  });
});

describe("the volume holding a person's files", () => {
  test("is named after their opaque key, so it is stable and leaks nothing", () => {
    for (const id of IDS) {
      expect(volumeNameFor(id)).toBe(`remii-user-${sandboxKeyFor(id)}`);
      expect(volumeNameFor(id)).not.toContain(id);
    }
  });

  test("gives every person their own volume", () => {
    /*
     * ONE PER PERSON, and this is where the two platforms genuinely differ.
     *
     * Daytona mounted a single shared volume at a per-user subpath and relied on the FUSE mount being
     * scoped to that prefix for isolation. E2B mounts a volume whole, at a path, with no equivalent
     * scoping — so a shared volume would put every person's desktop on one directory, and there is no
     * subpath trick available to fix it afterwards.
     */
    const names = IDS.map(volumeNameFor);
    expect(new Set(names).size).toBe(IDS.length);
  });

  test("is prefixed so it is identifiable in an operator's volume list", () => {
    // A volume called `alice-laptop-2` tells an operator whose it is. This one does not, which is the
    // point, and the prefix says which application created it instead.
    for (const id of IDS) {
      expect(volumeNameFor(id).startsWith("remii-user-")).toBe(true);
    }
  });
});

describe("the metadata written on every sandbox", () => {
  test("identifies the desktop by the opaque key and names the environment", () => {
    const meta = metadataFor("alice", "production");
    expect(meta).toMatchObject({
      provider: "e2b",
      computer: sandboxKeyFor("alice"),
      environment: "production",
      computer_type: "per-person",
    });
  });

  test("leaks no trace of the person", () => {
    // Serialised as a whole, because a leak in any single value is a leak.
    const meta = metadataFor("user_2f9a1c4e8b7d", "production");
    expect(JSON.stringify(meta)).not.toContain("user_2f9a1c4e8b7d");
    expect(JSON.stringify(meta)).not.toContain("alice");
  });

  test("is what makes orphan recovery possible", () => {
    /*
     * E2B takes no `name` on create, so this metadata is the ONLY handle a person has on their
     * desktop short of the database row. That is what the provisioner lists by when a row is missing,
     * and it is why `computer` carries the same opaque value the volume name does.
     */
    const meta = metadataFor("alice", "production");
    expect(Object.keys(meta)).toContain("computer");
    expect(meta.computer).toBeTruthy();
  });
});

describe("the ports and the resolution", () => {
  test("name noVNC's web port and RFB's port, which are not the same port", () => {
    // E2B's proxy exposes 6080, which websockify forwards to x11vnc's 5900. Both are passed to
    // `stream.start`, and naming one without the other leaves a reader wondering which is the real one.
    expect(NOVNC_PORT).toBe(6080);
    expect(VNC_PORT).toBe(5900);
    expect(NOVNC_PORT).not.toBe(VNC_PORT);
  });

  test("commit to a full-size desktop rather than a small one", () => {
    /*
     * 1920x1080 rather than 1280x720, which is the opposite of what the sampled-JPEG screen wanted.
     * Those frames were sent whole, every frame, so pixels cost bandwidth per frame and 1080p was
     * unaffordable. A VNC stream sends only the rectangles that changed, so cost tracks what is
     * happening on the screen rather than how large it is.
     */
    expect(DESKTOP_RESOLUTION).toEqual({ width: 1920, height: 1080 });
  });
});
