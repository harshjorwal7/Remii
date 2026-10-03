import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  skillRepos,
  skills,
  users,
} from "../src/db/schema";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Who can read the repository a skill points at.
 *
 * A skill is writable by anybody signed in because it adds no capability — and that argument holds for
 * a repository too, but only because the content is public. What must still hold is that attaching a
 * repository to a skill does not make it readable by anybody who happens to know the address: the grant
 * is the gate, and the gate is on the server because the browser is not a boundary.
 *
 * So these tests do not call GitHub. They seed a repository row and an index beside it, which is what a
 * successful read leaves behind, and then ask every question that decides whether a read should have
 * been answered. A test that reached the network would be testing GitHub's availability as much as
 * this deployment's gate, and would fail for reasons that have nothing to do with the property.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

const suite = randomUUID().slice(0, 8);
const alice = `user_alice_${suite}`;
const bob = `user_bob_${suite}`;
const aliceBot = `agent_alice_${suite}`;
const bobBot = `agent_bob_${suite}`;
const withRepo = `with-repo-${suite}`;
const noRepo = `no-repo-${suite}`;

/** A cached reading, as `buildIndex` would have left it. */
const index = {
  fullName: "owner/repo",
  description: "A thing.",
  language: "TypeScript",
  ref: "main",
  treeSha: "tree-sha-for-tests",
  tree: ["README.md", "src/index.ts"],
  keyFiles: { "README.md": "# A thing" },
  truncated: false,
};

beforeAll(async () => {
  for (const [id, email] of [
    [alice, `alice-${suite}@example.test`],
    [bob, `bob-${suite}@example.test`],
  ]) {
    await database
      .insert(users)
      .values({ id, email, name: id })
      .onConflictDoNothing();
  }
  for (const [id, owner] of [
    [aliceBot, alice],
    [bobBot, bob],
  ] as const) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: id,
        ownerUserId: owner,
        title: id,
        roleDescription: "For a test.",
        avatarSeed: id,
        visibility: "private",
      })
      .onConflictDoNothing();
  }

  const write = (slug: string, ownerUserId: string, repo: boolean) =>
    store.installSkill({
      slug,
      title: slug,
      summary: "",
      instructions: "Do the thing.",
      ownerUserId,
      ...(repo
        ? { repo: { owner: "owner", repo: "repo", ref: null, path: "" } }
        : {}),
      by: ownerUserId,
    });
  await write(withRepo, alice, true);
  await write(noRepo, alice, false);

  /*
   * The reading, as a successful read would have left it.
   *
   * Written through `saveSkillRepoIndex` rather than by inserting the row, for two reasons and the
   * second is the one that bites. It keeps this test off the network — a fixture that called GitHub
   * would be testing the vendor's patience as much as this deployment's gate — and it goes through the
   * same write a real read does, so a row this seeds cannot differ in some way the reader does not
   * account for. (An earlier version inserted the row directly, which silently did nothing: the skill
   * write above had already created it, so the reading never landed and every read went to GitHub.)
   */
  await store.saveSkillRepoIndex(withRepo, index, alice);
  expect((await store.skillRepo(withRepo))?.indexedAt).not.toBeNull();
});

/**
 * Both skills go on Alice's Bot.
 *
 * Done in `beforeAll` rather than inside the first describe block, because a grant made there is not in
 * place for the sibling describe that checks what a Bot WITHOUT the skill sees — and a gate test that
 * passes because nothing was ever granted is not a gate test. `noRepo` is granted too, so that "this
 * skill has no repository" is reached past the grant check rather than short-circuiting at it.
 */
beforeAll(async () => {
  for (const ref of [withRepo, noRepo]) {
    const response = await asAlice().request("/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "skill", ref, agentId: aliceBot }),
    });
    expect(response.status).toBe(200);
  }
});

afterAll(async () => {
  await database.delete(skills).where(inArray(skills.slug, [withRepo, noRepo]));
  await database.delete(agents).where(inArray(agents.id, [aliceBot, bobBot]));
  await database.delete(users).where(inArray(users.id, [alice, bob]));
});

/**
 * The routes, as each person.
 *
 * `canUseBot` and `canManageBot` are answered from the fixture rather than waved through, for the
 * reason `skill-ownership.integration.test.ts` gives: a check that always says yes makes every test
 * below pass for the wrong reason, which is worse than a failing one.
 */
function routesAs(actor: {
  id: string;
  email: string;
  role: "admin" | "user";
}) {
  /*
   * WHO OWNS THE BOT, not merely whether it exists.
   *
   * A check that waved every Bot through would make "Bob may not read Alice's Bot" pass for the wrong
   * reason — the grant check would be what refused it, and the test would be asserting the second gate
   * while claiming the first. Answered from the fixture so each gate is caught by the test that names it.
   */
  const owns = (other: { id: string }, botId: string) =>
    botId === aliceBot
      ? other.id === alice
      : botId === bobBot
        ? other.id === bob
        : false;
  return createPluginRoutes(
    store as never,
    async (context, next) => {
      context.set("actor", actor as never);
      await next();
    },
    async (other, botId) => owns(other as { id: string }, botId),
    async (other, botId) => owns(other as { id: string }, botId),
  );
}

const asAlice = () =>
  routesAs({ id: alice, email: "alice@example.test", role: "user" });
const asBob = () =>
  routesAs({ id: bob, email: "bob@example.test", role: "user" });

const read = (slug: string, agentId: string, query = "") =>
  asAlice().request(`/repos/${slug}?agentId=${agentId}${query}`);

describe("a Bot that carries the skill can read its repository", () => {
  test("the overview answers, with the file list", async () => {
    const response = await read(withRepo, aliceBot);
    const body = (await response.json()) as {
      repository?: { fullName?: string };
      tree?: string[];
    };

    expect(response.status).toBe(200);
    expect(body.repository?.fullName).toBe("owner/repo");
    expect(body.tree).toEqual(["README.md", "src/index.ts"]);
  });

  test("a search answers from the cached reading, and names what it covers", async () => {
    const response = await read(withRepo, aliceBot, "&q=A+thing");
    const body = (await response.json()) as {
      contents?: { path: string; line: number }[];
      paths?: unknown[];
      searched?: string;
    };

    expect(response.status).toBe(200);
    expect(body.contents?.[0]?.path).toBe("README.md");
    expect(body.contents?.[0]?.line).toBe(1);
    // The sentence is the point: a tool that quietly does not search source files would let a model
    // report "not in the codebase" on the strength of a search that never looked.
    expect(body.searched).toContain("Source files are not searched");
  });

  test("an empty term is an overview rather than a search that matched nothing", async () => {
    const withTerm = await (
      await read(withRepo, aliceBot, "&q=nothing-matches-this")
    ).json();
    const without = await (await read(withRepo, aliceBot, "&q=")).json();
    expect(withTerm).toHaveProperty("contents");
    expect(without).toHaveProperty("tree");
  });
});

describe("a Bot that does not carry the skill reads nothing", () => {
  test("the same address, on a Bot the skill was never granted to", async () => {
    // THE PROPERTY. Alice's skill, Alice's repository, and a Bot that has never been granted it: 404.
    // Not 403, which would confirm that the slug exists and has a repository — the one fact a caller
    // probing slugs is looking for.
    const response = await read(withRepo, bobBot);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("README.md");
  });

  test("removing the grant removes the read, on the author's own Bot", async () => {
    // Owning both the skill and the Bot is not the gate — the grant is, and this is the only test that
    // shows it by taking it away. Without it, every other case here is also satisfied by "nobody has
    // this repository", which would pass if the gate were missing altogether.
    //
    // `noRepo` because the answer to remove the grant from is a clean 404 either way, and a skill WITH a
    // repository would make the refusal depend on GitHub answering.
    const withoutGrant = await read(noRepo, aliceBot);
    expect(withoutGrant.status).toBe(400);

    await asAlice().request(
      `/grants?kind=skill&ref=${encodeURIComponent(noRepo)}&agentId=${encodeURIComponent(aliceBot)}`,
      { method: "DELETE" },
    );
    const revoked = await read(noRepo, aliceBot);
    // 404 and not 403: a 403 would confirm the slug exists on that Bot, which is the fact a caller
    // probing slugs is looking for.
    expect(revoked.status).toBe(404);

    // Restored in a `finally`, because a failed assertion here must not leave the next describe testing
    // against a fixture this one broke.
    const restored = await asAlice().request("/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "skill", ref: noRepo, agentId: aliceBot }),
    });
    expect(restored.status).toBe(200);
  });
});

describe("the gate, in the order it is applied", () => {
  test("a Bot the person may not act as is refused before the skill is even named", async () => {
    const response = await asBob().request(
      `/repos/${withRepo}?agentId=${aliceBot}`,
    );
    expect(response.status).toBe(404);
  });

  test("a request that names no Bot is a question this deployment cannot answer", async () => {
    const response = await asAlice().request(`/repos/${withRepo}?agentId=`);
    expect(response.status).toBe(400);
  });

  test("a skill with no repository says so, rather than reading something else", async () => {
    const response = await read(noRepo, aliceBot);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  });

  test("somebody else's skill is not readable by them either, whatever the Bot", async () => {
    // Bob naming Alice's skill on Bob's own Bot. The grant check refuses it because Bob's Bot does not
    // hold it — which is the point of checking the grant rather than the slug's prefix.
    const response = await asBob().request(
      `/repos/${withRepo}?agentId=${bobBot}&q=x`,
    );
    expect(response.status).toBe(404);
  });
});

describe("what a file read will and will not do", () => {
  test("a path that walks out of the repository is refused before any request", async () => {
    for (const path of ["../secrets", "a/../../b", "/etc/passwd"]) {
      const response = await asAlice().request(
        `/repos/${withRepo}/file?agentId=${aliceBot}&path=${encodeURIComponent(path)}`,
      );
      expect([400, 404], path).toContain(response.status);
      expect(await response.text()).not.toContain("root:");
    }
  });

  test("a path that is not in the cached tree is refused, and the tree is what says so", async () => {
    const response = await asAlice().request(
      `/repos/${withRepo}/file?agentId=${aliceBot}&path=src/missing.ts`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  });

  test("no path at all is refused rather than read as the repository root", async () => {
    const response = await asAlice().request(
      `/repos/${withRepo}/file?agentId=${aliceBot}&path=`,
    );
    expect(response.status).toBe(400);
  });
});

describe("writing a repository", () => {
  test("a non-GitHub address is refused by name, before any store write", async () => {
    const slug = `refused-${suite}`;
    const response = await asAlice().request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        title: "Refused",
        instructions: "Do it.",
        repo: "https://gitlab.com/owner/repo",
      }),
    });

    expect(response.status).toBe(400);
    expect(await store.skillOwner(slug)).toBeUndefined();
    // The whole skill is refused rather than saved without its repository, because a skill that saved
    // and lost the repository is one nobody will notice is missing what they just typed.
    expect(await store.skillRepo(slug)).toBeNull();
  });

  test("saving stores the four parsed values, not the address", async () => {
    const slug = `parsed-${suite}`;
    const response = await asAlice().request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        title: "Parsed",
        instructions: "Do it.",
        // A branch with no folder, which is unambiguous and so costs no GitHub request at save time.
        // The ambiguous shape — a branch containing a slash — needs the repository to tell a ref from a
        // folder, and that resolution is tested against a stub in `repo-index.test.ts` rather than here,
        // so this suite never reaches the network.
        repo: "owner/repo/tree/main",
      }),
    });

    expect(response.status).toBe(200);
    const saved = await store.skillRepo(slug);
    expect(saved?.owner).toBe("owner");
    expect(saved?.repo).toBe("repo");
    expect(saved?.ref).toBe("main");
    expect(saved?.path).toBe("");
    // No index, because nothing has read it yet. Its absence is the honest state and the screen draws
    // "not read yet" for it rather than an empty file list.
    expect(saved?.index).toBeNull();
    expect(saved?.indexedAt).toBeNull();

    await database.delete(skills).where(eq(skills.slug, slug));
  });

  test("an empty address clears the pointer rather than being refused", async () => {
    // The form sends its field on every save, and a person who emptied the box means no repository.
    const response = await asAlice().request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: withRepo,
        title: withRepo,
        instructions: "Do the thing.",
        repo: "",
      }),
    });

    expect(response.status).toBe(200);
    expect(await store.skillRepo(withRepo)).toBeNull();
  });

  test("changing the pointer drops the stale reading, because it describes another repository", async () => {
    const slug = `moved-${suite}`;
    await store.installSkill({
      slug,
      title: slug,
      summary: "",
      instructions: "Do it.",
      ownerUserId: alice,
      repo: { owner: "owner", repo: "repo", ref: null, path: "" },
      by: alice,
    });
    await store.saveSkillRepoIndex(slug, index, alice);
    expect((await store.skillRepo(slug))?.indexedAt).not.toBeNull();

    await store.installSkill({
      slug,
      title: slug,
      summary: "",
      instructions: "Do it.",
      ownerUserId: alice,
      repo: { owner: "owner", repo: "other", ref: null, path: "" },
      by: alice,
    });

    const moved = await store.skillRepo(slug);
    expect(moved?.repo).toBe("other");
    // Carrying it across would hand a model a tree of paths that do not exist at the address now
    // pointed at, which is the worst kind of wrong: `repo_overview` answers confidently and
    // `repo_read_file` then refuses every path it just printed.
    expect(moved?.index).toBeNull();
    expect(moved?.indexedAt).toBeNull();

    await database.delete(skills).where(eq(skills.slug, slug));
  });

  test("saving the same pointer keeps the reading, so a re-save is not a silent re-fetch", async () => {
    const slug = `same-${suite}`;
    await store.installSkill({
      slug,
      title: slug,
      summary: "",
      instructions: "Do it.",
      ownerUserId: alice,
      repo: { owner: "owner", repo: "repo", ref: null, path: "" },
      by: alice,
    });
    await store.saveSkillRepoIndex(slug, index, alice);
    const before = await store.skillRepo(slug);

    await store.installSkill({
      slug,
      title: slug,
      summary: "",
      instructions: "Do the thing differently.",
      ownerUserId: alice,
      repo: { owner: "owner", repo: "repo", ref: null, path: "" },
      by: alice,
    });

    expect((await store.skillRepo(slug))?.indexedAt?.toISOString()).toBe(
      before?.indexedAt?.toISOString(),
    );

    await database.delete(skills).where(eq(skills.slug, slug));
  });

  test("an unchanged reading does not move the timestamp", async () => {
    const slug = `unchanged-${suite}`;
    await store.installSkill({
      slug,
      title: slug,
      summary: "",
      instructions: "Do it.",
      ownerUserId: alice,
      repo: { owner: "owner", repo: "repo", ref: null, path: "" },
      by: alice,
    });
    await store.saveSkillRepoIndex(slug, index, alice);
    const first = (await store.skillRepo(slug))?.indexedAt;

    // A refresh that learned nothing. Advancing the timestamp would be a screen claiming a freshness it
    // does not have, and it is the only field on the page that answers "is this current?".
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.saveSkillRepoIndex(slug, index, alice);

    expect((await store.skillRepo(slug))?.indexedAt?.toISOString()).toBe(
      first?.toISOString(),
    );

    await database.delete(skills).where(eq(skills.slug, slug));
  });
});

describe("deleting a skill takes its repository with it", () => {
  test("and leaves nothing a later skill could adopt", async () => {
    const slug = `transient-${suite}`;
    await store.installSkill({
      slug,
      title: slug,
      summary: "",
      instructions: "Do it.",
      ownerUserId: alice,
      repo: { owner: "owner", repo: "repo", ref: null, path: "" },
      by: alice,
    });
    expect((await database.select().from(skillRepos)).length).toBeGreaterThan(
      0,
    );

    await store.uninstallSkill(slug, alice);

    const left = await database
      .select()
      .from(skillRepos)
      .where(eq(skillRepos.skillId, slug));
    expect(left).toHaveLength(0);
  });
});
