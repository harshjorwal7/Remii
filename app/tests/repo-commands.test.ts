import { describe, expect, test } from "bun:test";
import { repoCommands } from "@/lib/commands/repo-commands";
import type { SkillRepoSummary } from "@/lib/plugins/queries";

/**
 * A repo command directs an already-granted set of tools; it grants nothing. What it has to get
 * right is naming the repository and the ref it was read at, because that is the difference between
 * the model looking at this codebase and looking at a different branch of it.
 */

function summary(over: Partial<SkillRepoSummary> = {}): SkillRepoSummary {
  return {
    url: "https://github.com/acme/platform",
    ref: null,
    path: "",
    defaultRef: "main",
    indexedAt: null,
    truncated: false,
    fileCount: null,
    ...over,
  };
}

/** The granted-skill shape this builder reads: a slug, a title, and where it points. */
function skill(
  slug: string,
  repo: SkillRepoSummary | null,
): { slug: string; title: string; repo: SkillRepoSummary | null } {
  return { slug, title: slug, repo };
}

describe("repoCommands", () => {
  test("registers a skill's repository under its own namespaced name", () => {
    const commands = repoCommands([skill("how-we-deploy", summary())]);

    expect(commands).toHaveLength(1);
    expect(commands[0].id).toBe("repo-how-we-deploy");
    expect(commands[0].kind).toBe("chip");
    // Hidden: the menu offers one `/repo` entry, not one per repository.
    expect(commands[0].hidden).toBe(true);
  });

  test("skips a skill that points at no repository", () => {
    expect(repoCommands([skill("find-a-document", null)])).toEqual([]);
  });

  test("points the model at the branch and folder the author chose", () => {
    const [command] = repoCommands([
      skill(
        "how-we-deploy",
        summary({
          url: "https://github.com/acme/platform",
          ref: "release",
          path: "docs",
        }),
      ),
    ]);

    expect(command.prompt).toContain("https://github.com/acme/platform");
    expect(command.prompt).toContain("release");
    expect(command.prompt).toContain("docs/");
  });

  test("names no ref when the skill named none", () => {
    // The default branch is the repository's business; the command must not invent one.
    const [command] = repoCommands([skill("how-we-deploy", summary())]);

    expect(command.prompt).toContain("`https://github.com/acme/platform`.");
    expect(command.prompt).not.toContain(" at ");
  });

  test("starts the model at the overview rather than a guess", () => {
    const [command] = repoCommands([skill("how-we-deploy", summary())]);

    expect(command.prompt).toContain("repo_overview");
  });

  test("does not collide with the skill's own command", () => {
    // One chip, one instruction: sharing a slug would carry both on a single keystroke.
    const commands = repoCommands([skill("how-we-deploy", summary())]);

    expect(commands[0].id).not.toBe("how-we-deploy");
  });

  test("yields to a reserved name", () => {
    const commands = repoCommands(
      [skill("how-we-deploy", summary())],
      new Set(["repo-how-we-deploy"]),
    );

    expect(commands).toEqual([]);
  });

  test("one command per repository-bearing skill", () => {
    const commands = repoCommands([
      skill("how-we-deploy", summary()),
      skill(
        "how-we-roll-back",
        summary({ url: "https://github.com/acme/infra" }),
      ),
      skill("find-a-document", null),
    ]);

    expect(commands.map((command) => command.id)).toEqual([
      "repo-how-we-deploy",
      "repo-how-we-roll-back",
    ]);
  });
});
