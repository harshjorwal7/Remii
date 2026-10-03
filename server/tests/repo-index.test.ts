import { describe, expect, test } from "bun:test";
import {
  clipToContext,
  FILE_BYTE_LIMIT,
  FILE_LINE_LIMIT,
  isKeyFile,
  parseRepoRef,
  parseRepoRefOrThrow,
  RepoRefusedError,
  resolveAmbiguousRef,
  searchIndex,
  type RepoIndex,
} from "../src/plugins/repo-index";

/**
 * The real `fetch`, kept for the two tests below that replace it.
 *
 * Captured once at module scope rather than inside each test, because a test that swaps the global and
 * restores it from a value it read after swapping it has not restored anything. Both tests restore in a
 * `finally` regardless of what they assert.
 */
const realFetch = globalThis.fetch;

/**
 * Reading a public repository's address, and the limits on what goes into a model's context.
 *
 * The parser is the boundary. Everything below it builds requests against a constant host, so the only
 * way this deployment can be aimed at another machine is a parser that accepts a host — which is why
 * these tests are mostly about what it refuses rather than about what it reads.
 */

describe("reading an address somebody pasted", () => {
  test("takes the shapes people actually paste", () => {
    for (const input of [
      "https://github.com/owner/repo",
      "httpS://GitHub.com/owner/repo/",
      "https://www.github.com/owner/repo",
      "github.com/owner/repo",
      "owner/repo",
      "  https://github.com/owner/repo  ",
      "https://github.com/owner/repo.git",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} should be readable`).toBeTrue();
      if (!parsed.ok) continue;
      expect(parsed.value.owner).toBe("owner");
      expect(parsed.value.repo).toBe("repo");
    }
  });

  test("a branch and a folder come out of a browser URL", () => {
    // The shape the address bar holds for a folder inside a monorepo, which is the one a person is
    // actually copying when they say "point this skill at that package". The plain reading is what the
    // parser offers and what the Check button shows before the repository is asked which reading is
    // right.
    const parsed = parseRepoRef(
      "https://github.com/owner/repo/tree/main/packages/api",
    );
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    expect(parsed.value.ref).toBe("main");
    expect(parsed.value.path).toBe("packages/api");
    // Still flagged: a branch called `main/packages/api` is improbable but not impossible, and the
    // repository is the only thing that can rule it out.
    expect(parsed.value.ambiguous).toBeTrue();
  });

  test("a slashed branch is ambiguous, and the plain reading is offered rather than decided", () => {
    // `tree/release/2.4` is either one branch called `release/2.4` or a branch `release` with a folder
    // called `2.4`. Guessing would save a skill pointing at a folder the person never meant, looking
    // exactly as they typed it.
    const parsed = parseRepoRef(
      "https://github.com/owner/repo/tree/release/2.4",
    );
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    expect(parsed.value.ambiguous).toBeTrue();
    expect(parsed.value.ref).toBe("release");
    expect(parsed.value.path).toBe("2.4");
  });

  test("an address with no folder is never ambiguous, so saving it spends no GitHub request", () => {
    // This is the case worth protecting: the whole repository, or one branch of it, which is what
    // almost every skill points at and what must not cost a call on every save.
    for (const input of [
      "https://github.com/owner/repo",
      "https://github.com/owner/repo/tree/main",
      "https://github.com/owner/repo/commit/abc1234",
      "owner/repo",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} should be readable`).toBeTrue();
      if (!parsed.ok) continue;
      // The last one has no branch at all, so there is nothing that could be split.
      expect(
        parsed.value.ambiguous,
        `${input} should not be ambiguous`,
      ).toBeFalsy();
    }
  });

  test("a tag with a dot in it is a branch, not a folder", () => {
    const parsed = parseRepoRef("https://github.com/owner/repo/tree/v1.2.3");
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    expect(parsed.value.ref).toBe("v1.2.3");
    expect(parsed.value.path).toBe("");
    expect(parsed.value.ambiguous).toBeFalsy();
  });

  test("a commit URL reads as the commit, which is the same shape of thing", () => {
    const parsed = parseRepoRef("https://github.com/owner/repo/commit/abc1234");
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    expect(parsed.value.ref).toBe("abc1234");
    expect(parsed.value.path).toBe("");
  });

  test("the empty string is refused by name, not parsed into nonsense", () => {
    const parsed = parseRepoRef("   ");
    expect(parsed.ok).toBeFalse();
    if (parsed.ok) return;
    expect(parsed.error).toContain("required");
  });
});

describe("what it refuses, which is the security property", () => {
  test("any host other than github.com", () => {
    for (const input of [
      "https://gitlab.com/owner/repo",
      "https://github.com.evil.test/owner/repo",
      "https://evil.test/github.com/owner/repo",
      "https://raw.githubusercontent.com/owner/repo/main/README.md",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} must be refused`).toBeFalse();
    }
  });

  test("plain http, because the redirect is not ours to follow", () => {
    const parsed = parseRepoRef("http://github.com/owner/repo");
    expect(parsed.ok).toBeFalse();
    if (parsed.ok) return;
    expect(parsed.error).toContain("https");
  });

  test("an owner or repository carrying URL punctuation", () => {
    for (const input of [
      "https://github.com/owner/re%2Fpo",
      "https://github.com/own er/repo",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} must be refused`).toBeFalse();
    }
  });

  test("a link with options on it, which is not a repository address", () => {
    // `?ref=main` and `#readme` are both links to somewhere more specific than the repository root,
    // and dropping the options quietly would save a skill reading the whole repository when the person
    // meant something inside it.
    for (const input of [
      "https://github.com/owner/repo?ref=main",
      "https://github.com/owner/repo#readme",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} must be refused`).toBeFalse();
      if (parsed.ok) continue;
      expect(parsed.error).toContain("without a link");
    }
  });

  test("dot segments, which `URL` resolves away before this code could see them", () => {
    // `new URL("…/tree/main/a/../../b").pathname` is `/owner/repo/tree/b`, which arrives looking like a
    // branch somebody legitimately asked for. The evidence exists only on the raw string.
    for (const input of [
      "https://github.com/owner/repo/tree/main/a/../../b",
      "https://github.com/owner/repo/tree/..",
      "https://github.com/owner/repo/..",
      "https://github.com/owner/repo/tree/main/../../etc",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} must be refused`).toBeFalse();
      if (parsed.ok) continue;
      expect(parsed.error).toContain("outside the repository");
    }
  });

  test("a folder that steps outside the repository", () => {
    for (const input of [
      "https://github.com/owner/repo/tree/main/C:/windows",
      // The bare forms have no URL parser at all, so the dot check has to catch these too.
      "github.com/owner/repo/tree/main/packages/../../etc",
      "owner/repo/../other",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} must be refused`).toBeFalse();
    }
  });

  test("a branch that could change what the URL means", () => {
    for (const input of [
      "https://github.com/owner/repo/tree/..",
      "https://github.com/owner/repo/tree/main/../../other",
      "https://github.com/owner/repo/tree/HEAD@{1}",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} must be refused`).toBeFalse();
    }
  });

  test("a link to something inside a repository that is not the repository", () => {
    // Somebody following a link rather than naming a codebase. Guessing the repository out of a blob
    // URL would attach a skill to code they did not choose.
    for (const input of [
      "https://github.com/owner/repo/issues/12",
      "https://github.com/owner/repo/pull/13",
      "https://github.com/owner/repo/blob/main/README.md",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} must be refused`).toBeFalse();
    }
  });

  test("an address that names no repository", () => {
    for (const input of [
      "https://github.com/owner",
      "github.com/",
      "nonsense",
    ]) {
      const parsed = parseRepoRef(input);
      expect(parsed.ok, `${input} must be refused`).toBeFalse();
    }
  });

  test("the throwing form raises the same sentence the other one returns", () => {
    // So a route can use either without the two disagreeing about what is wrong.
    let raised: unknown;
    try {
      parseRepoRefOrThrow("https://gitlab.com/owner/repo");
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(RepoRefusedError);
    expect((raised as RepoRefusedError).status).toBe(400);
  });
});

describe("which files are carried whole", () => {
  test("the things that describe a repository, before the things that implement it", () => {
    for (const path of [
      "README.md",
      "readme.rst",
      "docs/guide.md",
      "Docs/architecture.mdx",
      "AGENTS.md",
      "package.json",
      "pyproject.toml",
      "go.mod",
      "Cargo.toml",
      "Dockerfile",
    ]) {
      expect(isKeyFile(path), `${path} should be carried`).toBeTrue();
    }
  });

  test("source and fixtures are not, because carrying them is what would not fit", () => {
    for (const path of [
      "src/index.ts",
      "server/src/plugins/store.ts",
      "tests/store.test.ts",
      "assets/logo.png",
      "fixtures/sample.json",
      "yarn.lock",
    ]) {
      expect(isKeyFile(path), `${path} should not be carried`).toBeFalse();
    }
  });
});

describe("keeping one tool result inside a context window", () => {
  test("a short file is returned whole, with nothing added", () => {
    const file = "one\ntwo\nthree";
    expect(clipToContext(file)).toBe(file);
  });

  test("a long file says what it left out, and why", () => {
    const file = Array.from(
      { length: FILE_LINE_LIMIT + 50 },
      (_, at) => `line ${at + 1}`,
    ).join("\n");
    const clipped = clipToContext(file);
    const [carried] = clipped.split("\n\n[Showing");

    expect(carried?.split("\n")).toHaveLength(FILE_LINE_LIMIT);
    // The part that matters: a model given a cut file with no indication that there was more will
    // reason about the part it has as though it were the whole file.
    expect(clipped).toContain(`Showing the first ${FILE_LINE_LIMIT}`);
    expect(clipped).toContain(`of ${FILE_LINE_LIMIT + 50} lines`);
    expect(clipped).toContain("startLine and endLine");
  });

  test("a file of very long lines is cut by bytes, and says that instead", () => {
    const file = "x".repeat(FILE_BYTE_LIMIT * 2);
    const clipped = clipToContext(file);

    expect(clipped.length).toBeLessThan(file.length);
    expect(clipped).toContain("very long lines");
  });
});

describe("deciding a slashed branch from a folder", () => {
  /**
   * GitHub, with only the one endpoint this resolution needs.
   *
   * Stubbed rather than avoided, because the alternative is leaving the resolution untested: it is the
   * one piece of this module that turns a question ("is `release/2.4` a ref or a folder?") into an
   * answer, and a test that skips it cannot tell a working resolver from a missing one. Everything else
   * in this file is a pure function and needs no such thing.
   */
  const withRefs = async (refs: string[], run: () => Promise<void>) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      expect(url).toStartWith("https://api.github.com/repos/owner/repo/");
      // Asserted rather than logged: a request to anywhere other than the one constant host is the
      // failure this whole module exists to make impossible, and it should fail here too.
      return new Response(JSON.stringify(refs.map((name) => ({ name }))), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  test("a branch that is really a branch wins over the folder reading", async () => {
    await withRefs(["refs/heads/main", "refs/heads/release/2.4"], async () => {
      const parsed = parseRepoRef(
        "https://github.com/owner/repo/tree/release/2.4/packages/api",
      );
      expect(parsed.ok).toBeTrue();
      if (!parsed.ok) return;
      const resolved = await resolveAmbiguousRef(parsed.value);

      expect(resolved.ref).toBe("release/2.4");
      expect(resolved.path).toBe("packages/api");
    });
  });

  test("no such branch, so it is a branch and a folder after all", async () => {
    await withRefs(["refs/heads/main", "refs/heads/release"], async () => {
      const parsed = parseRepoRef(
        "https://github.com/owner/repo/tree/release/2.4",
      );
      expect(parsed.ok).toBeTrue();
      if (!parsed.ok) return;
      const resolved = await resolveAmbiguousRef(parsed.value);

      expect(resolved.ref).toBe("release");
      expect(resolved.path).toBe("2.4");
    });
  });

  test("the LONGEST matching ref wins, which is GitHub's own rule", async () => {
    // Both `release` and `release/2.4` exist. The deeper one is the answer, because a repository
    // having a `release` branch and a `release/2.4` branch at once means the folder reading would
    // resolve to a branch, not to a directory.
    await withRefs(
      ["refs/heads/release", "refs/heads/release/2.4"],
      async () => {
        const parsed = parseRepoRef(
          "https://github.com/owner/repo/tree/release/2.4",
        );
        expect(parsed.ok).toBeTrue();
        if (!parsed.ok) return;
        const resolved = await resolveAmbiguousRef(parsed.value);
        expect(resolved.ref).toBe("release/2.4");
        expect(resolved.path).toBe("");
      },
    );
  });

  test("an address with no folder is passed straight through, with no request", async () => {
    const parsed = parseRepoRef("https://github.com/owner/repo/tree/main");
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    // The stub throws on any call, so a request here fails the test rather than quietly costing one.
    globalThis.fetch = (async () => {
      throw new Error("a resolution was asked for that should not have been");
    }) as typeof fetch;
    try {
      expect(await resolveAmbiguousRef(parsed.value)).toEqual(parsed.value);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("GitHub being unreachable leaves the plain reading rather than failing the save", async () => {
    globalThis.fetch = (async () => {
      throw new Error("no network");
    }) as typeof fetch;
    try {
      const parsed = parseRepoRef(
        "https://github.com/owner/repo/tree/release/2.4",
      );
      expect(parsed.ok).toBeTrue();
      if (!parsed.ok) return;
      // Saving a skill must not depend on GitHub being up. An undecided address still saves, and the
      // tree read refuses it later with a sentence naming both possibilities.
      expect(await resolveAmbiguousRef(parsed.value)).toEqual(parsed.value);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("searching", () => {
  const index: RepoIndex = {
    fullName: "owner/repo",
    description: "A thing.",
    language: "TypeScript",
    ref: "main",
    treeSha: "abc",
    tree: ["src/plugins/store.ts", "docs/architecture.md", "README.md"],
    keyFiles: {
      "README.md": "# A thing\n\nIt reads repositories.\n",
      "docs/architecture.md": "Grants are load-bearing.\n",
    },
    truncated: false,
  };

  test("finds a file by name, and the documentation by its text", () => {
    const paths = searchIndex(index, "store").paths;
    const contents = searchIndex(index, "load-bearing").contents;

    expect(paths.map((hit) => hit.path)).toEqual(["src/plugins/store.ts"]);
    expect(contents).toHaveLength(1);
    expect(contents[0]?.path).toBe("docs/architecture.md");
    // 1-based, because that is what a person reading it would count.
    expect(contents[0]?.line).toBe(1);
  });

  test("matching ignores case, because a model's capital is not a decision", () => {
    expect(searchIndex(index, "GRANTS").contents).toHaveLength(1);
  });

  test("an empty term finds nothing rather than everything", () => {
    expect(searchIndex(index, "  ")).toEqual({ paths: [], contents: [] });
  });

  test("a source file's contents are not searched, and nothing pretends otherwise", () => {
    // `store.ts` is in the tree but not carried, so a string that only appears in source is not found.
    // The tool description says as much; this is the test that the description is true.
    expect(searchIndex(index, "unknownToTheIndex").contents).toHaveLength(0);
    expect(index.keyFiles).not.toHaveProperty("src/plugins/store.ts");
  });
});
