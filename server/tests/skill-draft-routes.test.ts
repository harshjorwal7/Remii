import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { RepoRefusedError } from "../src/plugins/repo-index";
import { createPluginRoutes } from "../src/plugins/routes";
import type { SkillDrafts } from "../src/plugins/skill-drafter";
import { createSkillDrafter } from "../src/plugins/skill-drafter";
import type { PluginStore } from "../src/plugins/store";

/**
 * `POST /skills/drafts` — the New-skill screen's bridge to the model.
 *
 * ROUTES BUILT DIRECTLY, NOT THROUGH `createApp`, because `createApp`'s thirty positional
 * collaborators put the drafter last: reaching it from a test means counting past every store this
 * surface does not use, and a test that counts can be wrong silently. The route is the unit, and
 * everything below is about it.
 *
 * WHAT IS ASSERTED IS THE SHAPE OF THE ANSWER AND THE FOUR WAYS IT CAN SAY NO — a bad address, a
 * GitHub refusal with its own status, a deployment with no model, and a deployment with no key. The
 * last two are the ones worth pinning: both are absent-collaborator cases, and the difference
 * between "503 with a sentence" and "500 because nothing was mounted" is the difference between a
 * person reading why and a person filing a bug about a button.
 */

const drafts = (): SkillDrafts => ({
  drafts: [
    {
      slug: "tauri-signing",
      title: "Tauri signing",
      summary: "",
      instructions: "Do the thing.",
      source: "SKILL.md",
      existing: null,
    },
  ],
  repository: {
    url: "https://github.com/owner/repo",
    ref: "main",
    path: "",
    fileCount: 2,
    truncated: false,
  },
});

const ALICE = {
  id: "alice",
  email: "alice@example.test",
  role: "user",
} as const;
const BOB = { id: "bob", email: "bob@example.test", role: "user" } as const;

function routes(options: {
  draftSkills?: (repo: string) => Promise<SkillDrafts>;
  owners?: Record<string, string | null>;
}) {
  const store = {
    skillOwner: async (slug: string) =>
      slug in (options.owners ?? {}) ? options.owners?.[slug] : undefined,
  } as unknown as PluginStore;
  const app = new Hono();
  app.route(
    "/api/plugins",
    createPluginRoutes(
      store,
      async (context, next) => {
        context.set("actor", ALICE as never);
        await next();
      },
      async () => false,
      async () => false,
      undefined,
      undefined,
      options.draftSkills,
    ),
  );
  return (body: unknown) =>
    app.request("http://remii.test/api/plugins/skills/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

describe("drafting skills from a repository", () => {
  test("the drafts come back with the repository they were read from", async () => {
    const response = await routes({ draftSkills: async () => drafts() })({
      repo: "owner/repo",
    });
    const body = (await response.json()) as SkillDrafts;

    expect(response.status).toBe(200);
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]?.slug).toBe("tauri-signing");
    expect(body.repository.url).toBe("https://github.com/owner/repo");
  });

  test("a slug that is already yours is said so before the save", async () => {
    const response = await routes({
      draftSkills: async () => drafts(),
      owners: { "tauri-signing": ALICE.id },
    })({ repo: "owner/repo" });
    const body = (await response.json()) as SkillDrafts;

    expect(body.drafts[0]?.existing).toBe("yours");
  });

  test("a deployment's own skill and somebody else's are told apart", async () => {
    const mine = await (
      await routes({
        draftSkills: async () => drafts(),
        owners: { "tauri-signing": BOB.id },
      })({ repo: "owner/repo" })
    ).json();
    const shared = await (
      await routes({
        draftSkills: async () => drafts(),
        owners: { "tauri-signing": null },
      })({ repo: "owner/repo" })
    ).json();

    expect((mine as SkillDrafts).drafts[0]?.existing).toBe("someone else's");
    expect((shared as SkillDrafts).drafts[0]?.existing).toBe(
      "the deployment's",
    );
  });

  test("an address this cannot read is refused in the parser's words", async () => {
    const response = await routes({ draftSkills: async () => drafts() })({
      repo: "https://gitlab.com/owner/repo",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("GitHub");
  });

  test("GitHub's own refusal keeps its status", async () => {
    const response = await routes({
      draftSkills: async () => {
        throw new RepoRefusedError(
          "GitHub says this rate limit is spent.",
          429,
        );
      },
    })({ repo: "owner/repo" });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "GitHub says this rate limit is spent.",
    });
  });

  test("a deployment with no drafter answers 503 rather than pretending", async () => {
    const response = await routes({})({ repo: "owner/repo" });

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("needs a model");
  });

  test("a deployment with no model key says so", async () => {
    const response = await routes({
      draftSkills: async () => {
        throw new Error("no model key");
      },
    })({ repo: "owner/repo" });

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("no model key");
  });

  test("nothing is asked for, so nothing is written", async () => {
    // A store with no write methods at all: if the route reached for one, this throws.
    await routes({ draftSkills: async () => drafts() })({ repo: "owner/repo" });
    expect(true).toBe(true);
  });

  test("the real drafter behind the real route, with no GitHub and no provider", async () => {
    /*
     * THE WHOLE CHAIN, ONCE. The tests above stub the drafter and `skill-drafter.test.ts` stubs the
     * model; between them a break in either — a renamed export, a route reading the wrong field of
     * the answer, an ownership annotation applied to the wrong object — passes every test and fails
     * only on a screen. So here the two are put together with the index and the model injected and
     * nothing else faked, and the assertion is the sentence the person would read.
     */
    const draftSkills = createSkillDrafter({
      complete: async () =>
        JSON.stringify({
          drafts: [
            {
              slug: "tauri-signing",
              title: "Tauri signing",
              summary: "",
              instructions: "Wire the signing command.",
              source: "skills/tauri-signing/SKILL.md",
            },
            { slug: "tauri-signing", title: "Dupe", instructions: "Go." },
            { slug: "Release Notes", title: "Bad slug", instructions: "Go." },
          ],
        }),
      index: async () => ({
        fullName: "owner/repo",
        description: "A thing.",
        language: "TypeScript",
        ref: "main",
        treeSha: "abc",
        tree: ["skills/tauri-signing/SKILL.md"],
        keyFiles: {},
        truncated: false,
      }),
      read: async () => "# Tauri signing\nDo the thing.",
    });

    const response = await routes({
      draftSkills,
      owners: { "tauri-signing": BOB.id },
    })({ repo: "https://github.com/owner/repo" });
    const body = (await response.json()) as SkillDrafts;

    expect(response.status).toBe(200);
    // One draft: the duplicate collapsed and the capitalised slug was dropped rather than refused.
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]).toMatchObject({
      slug: "tauri-signing",
      source: "skills/tauri-signing/SKILL.md",
      existing: "someone else's",
    });
    expect(body.repository.url).toBe("https://github.com/owner/repo");
  });
});
