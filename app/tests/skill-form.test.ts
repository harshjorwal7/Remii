import { describe, expect, test } from "bun:test";
import {
  emptySkillForm,
  repoUrlRefusal,
  skillFormSchema,
  splitRepoUrl,
  undeclaredElsewhere,
} from "@/lib/skills/form";

/**
 * The declared tools, as the form carries them.
 *
 * A skill needing no tool is the ordinary case, and a skill that had its last one unticked has to
 * submit as an empty array rather than as an absent field — the server replaces the set when the
 * field is present and leaves it alone when it is not, so those two are different requests.
 */

const valid = {
  slug: "standup",
  title: "Standup",
  summary: "",
  instructions: "Summarise yesterday.",
};

describe("declaring the tools a skill needs", () => {
  test("a new skill starts with none declared", () => {
    expect(emptySkillForm.tools).toEqual([]);
    // And the empty form is a shape the schema accepts, apart from the fields a person has to fill.
    expect(
      skillFormSchema.safeParse({ ...emptySkillForm, ...valid }).success,
    ).toBeTrue();
  });

  test("no tools is valid, and stays an array", () => {
    const parsed = skillFormSchema.safeParse({
      ...valid,
      tools: [],
      repo: null,
    });
    expect(parsed.success).toBeTrue();
    // Present rather than stripped: this is what clears the set on a skill that used to declare one.
    expect(parsed.success && parsed.data.tools).toEqual([]);
  });

  test("refs are carried through as written", () => {
    // `<serverId>/<toolName>`, the same key a grant is written against. The form does not reformat
    // them, because the server compares them to grant refs character for character.
    const tools = ["acme-docs/find_document", "acme-chat/search_messages"];
    const parsed = skillFormSchema.safeParse({ ...valid, tools, repo: null });
    expect(parsed.success && parsed.data.tools).toEqual(tools);
  });

  test("the field is required, so a save always says what the set is now", () => {
    // Omitting it would submit a save the server reads as "leave the tools alone", which is not what
    // a form with nothing ticked means.
    expect(skillFormSchema.safeParse(valid).success).toBeFalse();
  });

  test("a ref this deployment has never seen is left to the server", () => {
    /*
     * Not validated here on purpose. The server refuses an unknown ref with a sentence naming it, and
     * it is the only side that knows which tools exist — a list reconstructed in the browser would go
     * stale the moment a server's tools were refreshed.
     */
    expect(
      skillFormSchema.safeParse({
        ...valid,
        tools: ["nope/not_a_tool"],
        repo: null,
      }).success,
    ).toBeTrue();
  });
});

/**
 * The repository the form carries, and the address it is split back into.
 *
 * `splitRepoUrl` is a MIRROR of the server's parser rather than a copy of it — importing from
 * `server/src` would pull a module that reads `process.env` into a browser bundle. So what is tested
 * here is that the mirror still agrees with the server, which is the only property that matters and the
 * only reason it is allowed to exist. The server's own tests cover what it refuses.
 */

describe("the repository a skill points at", () => {
  test("a new skill starts with none, and null is what says none", () => {
    // Null rather than an empty string, because the server treats the two the same and null is the
    // one this form sends on every save — so a person who empties the box gets a skill with no
    // repository rather than a save that quietly changed nothing.
    expect(emptySkillForm.repo).toBeNull();
    expect(
      skillFormSchema.safeParse({ ...emptySkillForm, ...valid }).success,
    ).toBeTrue();
  });

  test("the field is required, so a save always says what the repository is now", () => {
    expect(skillFormSchema.safeParse(valid).success).toBeFalse();
  });

  test("an address is carried through as written, because the server parses it", () => {
    // No normalisation here. The field holds what a person pasted, the Check button shows what it
    // means, and the server is the only thing that decides what is stored.
    const repo = "https://github.com/owner/repo/tree/main/packages/api";
    const parsed = skillFormSchema.safeParse({ ...valid, tools: [], repo });
    expect(parsed.success && parsed.data.repo).toBe(repo);
  });

  test("the round trip holds, which is what stops an edit dropping the branch", () => {
    // The address the server hands the edit form, split back into what a save would store. If the split
    // lost a branch or a folder, opening a skill and pressing Save would silently repoint it — and the
    // failure would be invisible, because the address still looks like what was typed.
    //
    // `ref: null` reads back as `HEAD`, which is the point of that pair: `parseRepoRef` accepts `HEAD`
    // as a ref and `readTree` resolves it to the default branch on every read, so an unpinned repository
    // with a folder keeps following its default rather than becoming pinned to whatever the default was
    // the day somebody saved the form.
    for (const [stored, readBack] of [
      [
        { ref: null, path: "" },
        { ref: null, path: "" },
      ],
      [
        { ref: "main", path: "" },
        { ref: "main", path: "" },
      ],
      [
        { ref: null, path: "packages/api" },
        { ref: "HEAD", path: "packages/api" },
      ],
      // A BRANCH CONTAINING A SLASH IS NOT ROUND-TRIPPED HERE, and deliberately: `splitRepoUrl` can only
      // offer the plain reading of `release/2.4`, because nothing in an address says whether it is one
      // ref or a ref and a folder. The save route asks the repository and gets the same answer back —
      // `resolveAmbiguousRef` in `repo-index.test.ts` is the other half of this pair.
      [
        { ref: "release/2.4", path: "packages/api" },
        { ref: "release", path: "2.4/packages/api" },
      ],
    ] as const) {
      const address = `https://github.com/owner/repo${
        stored.ref || stored.path
          ? `/tree/${stored.ref ?? "HEAD"}${stored.path ? `/${stored.path}` : ""}`
          : ""
      }`;
      expect(splitRepoUrl(address)).toEqual({
        owner: "owner",
        repo: "repo",
        ...readBack,
      });
    }
  });

  test("HEAD is what a repository with no pinned branch reads back as", () => {
    // `parseRepoRef` accepts `HEAD` as a ref and `readTree` resolves it to the default branch on every
    // read, which is what lets a folder be written into the address of a repository that is not pinned.
    // The pair has to agree, or a saved folder disappears the next time the skill is edited.
    const split = splitRepoUrl(
      "https://github.com/owner/repo/tree/HEAD/packages/api",
    );
    expect(split?.ref).toBe("HEAD");
    expect(split?.path).toBe("packages/api");
  });

  test("the obvious ways of writing an address are all read", () => {
    for (const input of [
      "https://github.com/owner/repo",
      "github.com/owner/repo",
      "owner/repo",
      "owner/repo/tree/main/packages/api",
      "  https://github.com/owner/repo.git  ",
    ]) {
      expect(splitRepoUrl(input), input).not.toBeNull();
      expect(repoUrlRefusal(input), input).toBeNull();
    }
  });

  test("a host that is not GitHub is refused here, so the form can say so while typing", () => {
    // The one refusal the browser can make honestly, because it is the same boundary the server draws:
    // a URL pointing anywhere else is a host this deployment will not be asked for.
    expect(repoUrlRefusal("https://gitlab.com/owner/repo")).toContain(
      "Only GitHub",
    );
    expect(splitRepoUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  test("plain http is refused, because the redirect is not ours to follow", () => {
    expect(repoUrlRefusal("http://github.com/owner/repo")).toContain("https");
  });

  test("something that is not an address says so, in the words the server uses", () => {
    for (const input of ["nonsense", "github.com/", "just some text"]) {
      expect(repoUrlRefusal(input), input).toContain("github.com");
    }
  });

  test("a dot segment is refused rather than resolved away", () => {
    expect(repoUrlRefusal("owner/repo/tree/main/../other")).toContain(
      "outside the repository",
    );
  });

  test("a null repository is not a problem, because most skills have none", () => {
    const parsed = skillFormSchema.safeParse({
      ...valid,
      tools: [],
      repo: null,
    });
    expect(parsed.success).toBeTrue();
  });
});

/**
 * Declared refs the picker cannot draw as a tool.
 *
 * The picker lists the tools of the servers this deployment has connected, and a declaration is not
 * confined to those: a package ships skills naming tools for connectors nobody has added yet, and a
 * person's own skill outlives the server it was written against. Anything left over has to be shown,
 * or the screen states part of the declaration as though it were the whole of it.
 */
describe("declared tools no connected server offers", () => {
  const offered = [
    "google-drive/search_files",
    "google-drive/read_file_content",
  ];

  test("a ref for a connector nobody has added is surfaced", () => {
    expect(
      undeclaredElsewhere(
        ["google-drive/search_files", "jira/search_issues"],
        offered,
      ),
    ).toEqual(["jira/search_issues"]);
  });

  test("a fully matched declaration leaves nothing over", () => {
    expect(undeclaredElsewhere(offered, offered)).toEqual([]);
  });

  test("declaring nothing leaves nothing over", () => {
    expect(undeclaredElsewhere([], offered)).toEqual([]);
  });

  test("with no server connected, every declared ref is left over", () => {
    // The case a fresh clone is in: the package ships skills declaring Drive tools and Drive has not
    // been connected. Every one of them has to be visible, or the skill reads as declaring nothing.
    expect(
      undeclaredElsewhere(
        ["google-drive/search_files", "google-drive/read_file_content"],
        [],
      ),
    ).toEqual(["google-drive/search_files", "google-drive/read_file_content"]);
  });

  test("order is the declaration's, so the list does not reshuffle as servers connect", () => {
    expect(undeclaredElsewhere(["z/one", "a/two", "m/three"], [])).toEqual([
      "z/one",
      "a/two",
      "m/three",
    ]);
  });
});
