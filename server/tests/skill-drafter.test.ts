import { describe, expect, test } from "bun:test";
import type { RepoIndex } from "../src/plugins/repo-index";
import {
  createSkillDrafter,
  DRAFT_CAP,
  readDrafts,
  skillFileCandidates,
} from "../src/plugins/skill-drafter";

/**
 * Drafting skills out of a repository.
 *
 * The assertions are about three things the feature promises and could quietly break. The first is
 * that every skill file in a tree is drafted, not the first one `git/trees` happened to hand back —
 * the ordering function is tested directly for that reason, because "as many as the repo contains"
 * is a promise about a list, and a list sorted by whatever GitHub returned is not one. The second is
 * that a malformed draft costs that draft rather than the answer: six good drafts and one with a
 * capital in its slug must come back as six. The third is that nothing here reaches GitHub — the
 * drafter is driven through injected index and read functions, and the only network call in the
 * production path is the one a deployment makes on purpose.
 */

const index = (over: Partial<RepoIndex> = {}): RepoIndex => ({
  fullName: "owner/repo",
  description: "A repository.",
  language: "TypeScript",
  ref: "main",
  treeSha: "abc",
  tree: ["SKILL.md"],
  keyFiles: {},
  truncated: false,
  ...over,
});

/** A drafter over a canned index and a canned answer, with no fetch anywhere in sight. */
const drafter = (
  answer: string,
  over: { index?: RepoIndex; read?: Record<string, string> } = {},
) =>
  createSkillDrafter({
    complete: async () => answer,
    index: async () => over.index ?? index(),
    read: async (_spec, path) => over.read?.[path] ?? `content of ${path}`,
  });

describe("which files become drafts", () => {
  test("every skill file is found, not just the first", () => {
    const paths = [
      "packages/api/docs/SKILL.md",
      "SKILL.md",
      "skills/release-notes.md",
      "Tauri-signing-SKILL.md",
    ];
    expect(skillFileCandidates(paths).sort()).toEqual([...paths].sort());
  });

  test("the shallowest file sorts first, so a root skill is drafted before a nested one", () => {
    expect(skillFileCandidates(["a/b/SKILL.md", "SKILL.md"])).toEqual([
      "SKILL.md",
      "a/b/SKILL.md",
    ]);
  });

  test("a file that is not a skill is not drafted", () => {
    expect(
      skillFileCandidates([
        "README.md",
        "src/skills.ts",
        "src/agent-skill.ts",
        "docs/SKILL.md.bak",
      ]),
    ).toEqual([]);
  });
});

describe("reading the model's answer", () => {
  test("a fenced object is read from its object, not its prose", () => {
    const drafts = readDrafts(
      'Here you go:\n```json\n{"drafts":[{"slug":"one","title":"One","summary":"","instructions":"Do the thing.","source":"SKILL.md"}]}\n```',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts?.[0]?.slug).toBe("one");
  });

  test("an answer with no object is not a set of drafts", () => {
    expect(readDrafts("I could not read that repository.")).toBeNull();
    expect(readDrafts("{not json")).toBeNull();
    expect(readDrafts('{"other":[]}')).toBeNull();
  });

  test("one malformed draft costs that draft and not the answer", () => {
    const drafts = readDrafts(
      JSON.stringify({
        drafts: [
          { slug: "Keep Me", title: "Kept", summary: "", instructions: "Go." },
          {
            slug: "keep-me-too",
            title: "Also kept",
            summary: "",
            instructions: "Go.",
          },
        ],
      }),
    );
    expect(drafts?.map((draft) => draft.slug)).toEqual(["keep-me-too"]);
  });

  test("two drafts under one slug are one draft", () => {
    const drafts = readDrafts(
      JSON.stringify({
        drafts: [
          { slug: "same", title: "First", summary: "", instructions: "Go." },
          { slug: "same", title: "Second", summary: "", instructions: "Go." },
        ],
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts?.[0]?.title).toBe("First");
  });

  test(`a model that dictates more than ${DRAFT_CAP} drafts is capped`, () => {
    const drafts = readDrafts(
      JSON.stringify({
        drafts: Array.from({ length: DRAFT_CAP + 5 }, (_, index) => ({
          slug: `skill-${index}`,
          title: `Skill ${index}`,
          summary: "",
          instructions: "Go.",
        })),
      }),
    );
    expect(drafts).toHaveLength(DRAFT_CAP);
  });
});

describe("drafting a repository", () => {
  test("a bad address is refused with the parser's sentence", async () => {
    const draft = drafter("{}")("https://gitlab.com/owner/repo");
    await expect(draft).rejects.toThrow(/GitHub/);
  });

  test("drafts answer with the repository they were read from", async () => {
    const result = await drafter(
      JSON.stringify({
        drafts: [
          {
            slug: "ship-it",
            title: "Ship it",
            summary: "",
            instructions: "Go.",
            source: "SKILL.md",
          },
        ],
      }),
    )("owner/repo");
    expect(result.repository).toEqual({
      url: "https://github.com/owner/repo",
      ref: "main",
      path: "",
      fileCount: 1,
      truncated: false,
    });
    expect(result.drafts[0]?.existing).toBeNull();
  });

  test("no skill file at all still produces a draft, grounded in the carried files", async () => {
    let seen = "";
    const draft = createSkillDrafter({
      complete: async (prompt) => {
        seen = prompt;
        return JSON.stringify({
          drafts: [
            {
              slug: "about-this-repo",
              title: "About",
              summary: "",
              instructions: "Go.",
            },
          ],
        });
      },
      index: async () =>
        index({ tree: ["README.md"], keyFiles: { "README.md": "# Hello" } }),
      read: async () => "never read",
    });
    const result = await draft("owner/repo");
    expect(result.drafts).toHaveLength(1);
    expect(seen).toContain("No SKILL.md files were found");
    expect(seen).toContain("# Hello");
  });

  test("a model answer with no object is zero drafts, not an error", async () => {
    const result = await drafter("I don't know")("owner/repo");
    expect(result.drafts).toEqual([]);
  });
});
