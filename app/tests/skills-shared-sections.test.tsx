import { describe, expect, test } from "bun:test";
import type { PluginSkill } from "@/lib/plugins/queries";
import {
  COMPUTER_SKILL_SLUGS,
  splitSkills,
} from "@/components/skills/skills-section";

/**
 * A DEPLOYMENT WITH SEVENTY SKILLS LOOKED LIKE IT HAD NONE.
 *
 * The Apps page listed every connected service and not one skill. Skills lived on their own page, reachable
 * only from the sidebar — so a person opening the page that answers "what can this deployment do for me"
 * was shown a list of connectors and no mention of the instructions that make a Bot use them. The rows
 * existed, were readable, and were somewhere nobody was looking.
 *
 * Both pages now group the same three lists from one function, and that is the part worth holding in
 * place. The grouping is the only reason four computer-use skills are findable at all: they arrive as
 * ordinary deployment rows and would otherwise sit in a list of connector workflows. A second copy of
 * that set is a second thing to forget, and the failure is invisible — the rows just quietly move, and
 * nobody notices until a Bot clicks at coordinates it invented.
 *
 * A `.tsx` file because it imports a component module, which is JSX; the precedent is
 * `connected-accounts-list.test.tsx`, which exports its own rule as a function for the same reason.
 */

function skill(overrides: Partial<PluginSkill> & { slug: string }): PluginSkill {
  return {
    id: `skill-${overrides.slug}`,
    ownerUserId: null,
    title: overrides.slug,
    summary: "",
    instructions: "",
    origin: "deployment",
    installedBy: null,
    grantedTo: [],
    tools: [],
    ...overrides,
  } as PluginSkill;
}

const ME = "user-1";

describe("grouping skills the same way on every page", () => {
  test("separates a person's own skills from the deployment's", () => {
    const { mine, included, computerUse } = splitSkills(
      [
        skill({ slug: "my-own", ownerUserId: ME }),
        skill({ slug: "theirs", ownerUserId: "user-2" }),
        skill({ slug: "shipped" }),
      ],
      ME,
    );

    // Somebody else's skill is in none of the three lists rather than in two of them. The server already
    // scopes the read so it cannot arrive; this is the property being relied on if that ever changes.
    expect(mine.map((row) => row.slug)).toEqual(["my-own"]);
    expect(included.map((row) => row.slug)).toEqual(["shipped"]);
    expect(computerUse).toEqual([]);
  });

  test("pulls the computer-use skills out, so they are not lost in the connector list", () => {
    const { computerUse, included } = splitSkills(
      [
        skill({ slug: "drive-a-desktop" }),
        skill({ slug: "browse-the-web" }),
        skill({ slug: "find-a-document" }),
      ],
      ME,
    );

    expect(computerUse.map((row) => row.slug)).toEqual([
      "drive-a-desktop",
      "browse-the-web",
    ]);
    expect(included.map((row) => row.slug)).toEqual(["find-a-document"]);
  });

  test("groups exactly the four computer-use skills and nothing else", () => {
    /*
     * Pinned because the set is duplicated from the server and a stale entry cannot fail loudly. A slug
     * added here wrongly pulls a connector workflow out of the list a person is reading; one removed
     * silently buries the instructions that stop Remii clicking at invented coordinates.
     */
    expect([...COMPUTER_SKILL_SLUGS].sort()).toEqual([
      "browse-the-web",
      "desktop-shell-and-files",
      "drive-a-desktop",
      "long-desktop-tasks",
    ]);
  });

  test("reads no person's skills as their own before the person is known", () => {
    /*
     * Absent `userId` every row reads as a deployment skill, so "Your skills" is briefly missing rather
     * than briefly showing somebody else's. The alternative — guessing — would put a person's skill under
     * a heading saying it belongs to the deployment.
     */
    const { mine, included } = splitSkills(
      [skill({ slug: "my-own", ownerUserId: ME }), skill({ slug: "shipped" })],
      undefined,
    );

    expect(mine).toEqual([]);
    // Still a deployment row, because `ownerUserId` is literally null on it. The person's own row belongs
    // to none of the three lists until we know who they are.
    expect(included.map((row) => row.slug)).toEqual(["shipped"]);
  });

  test("returns nothing to draw for a deployment with no skills at all", () => {
    const split = splitSkills([], ME);
    expect(split.mine).toEqual([]);
    expect(split.included).toEqual([]);
    expect(split.computerUse).toEqual([]);
  });
});