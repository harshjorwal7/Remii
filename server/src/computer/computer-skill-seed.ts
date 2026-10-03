/**
 * Putting the built-in computer skills in the database on boot.
 *
 * WHY THIS EXISTS RATHER THAN A TENANT PACKAGE. Deployment skills have exactly one existing ship
 * path — `skills.yaml` in the tenant package — and the computer skills cannot use it. A package is
 * something an operator supplies for THEIR deployment: their Bots, their connectors, their
 * workflows. These four are not that. They describe Remii's own hosted desktop, which every
 * deployment with a E2B computer has and which no package should have to know about in order to
 * have working instructions for it. Shipping them from the package would mean every install that
 * forgot a line of YAML got a Bot that could see the screen and had no idea it was supposed to look
 * before it clicked.
 *
 * So they are seeded here, at boot, as `origin: "catalogue"` deployment skills — the same shape the
 * package writes, and the same thing the Skills page's "Included skills" section draws.
 *
 * WHY NOT `installSkill` FROM THE STORE. It validates every declared ref against `knownToolRefs`,
 * which is built from the `mcp_tools` table, and it should: that is the right check for a ref
 * somebody typed into a form. The computer refs are `computer/computer_click` and friends, which are
 * never in that table — the desktop is a first-party capability, not a connector — so the store would
 * refuse every one of them. The tenant package writes `skill_tools` directly for the same reason, and
 * so does this. The skills declare nothing (see `computer-skills.ts` for why), so there is nothing
 * here to validate: `skill_tools` stays empty and no ref is ever asserted.
 *
 * WHAT A REINSTALL DOES AND DOES NOT DO, which is the part that matters:
 *
 * - The instruction text IS rewritten on every boot. This file is the source of truth, so an
 *   improvement to how to drive a desktop reaches every deployment on restart rather than needing a
 *   migration.
 * - A PERSON'S OWN SKILL KEEPS THE SLUG. `onConflictDoUpdate` carries the same `setWhere` the package
 *   uses — `origin = 'catalogue'` — so if somebody has written `/drive-a-desktop` themselves, their
 *   skill wins and ours is skipped with a warning. Silently replacing something a person wrote would
 *   be far worse than losing a default, and the `/` namespace being first-come is a rule the rest of
 *   this codebase already keeps.
 * - NOBODY'S GRANTS ARE TOUCHED. The grants a person made through the Skills page are theirs, and a
 *   restart is not a licence to revoke them. That is the same rule the package's grant rewriting
 *   follows, restricted further here because these skills grant nothing anyway.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  pluginGrants,
  skills as skillTable,
  skillTools,
} from "../db/schema/plugins";
import { COMPUTER_SKILLS } from "./computer-skills";

/** Who the seeded skills are attributed to. Not a user id — nobody authored these. */
const SEED_GRANTED_BY = "remii";

/**
 * Write the built-in computer skills, and grant them to the Bot that holds the computer.
 *
 * `agentId` is the Bot the desktop is attached to, or null to seed the skills without granting them.
 * Passing null is what the tests do, and is right for a deployment whose computer-holding Bot does
 * not exist yet — a missing Bot is not a reason to fail a boot.
 */
export async function seedComputerSkills(
  database: Database,
  agentId: string | null = null,
): Promise<{ seeded: string[]; skipped: string[] }> {
  const seeded: string[] = [];
  const skipped: string[] = [];

  for (const skill of COMPUTER_SKILLS) {
    const [row] = await database
      .insert(skillTable)
      .values({
        // The slug IS the id, as the package does it. It is stable, human-readable in a log, and
        // makes the `skill_tools` join obvious when somebody is reading the database.
        id: skill.slug,
        ownerUserId: null,
        slug: skill.slug,
        title: skill.title,
        summary: skill.summary,
        instructions: skill.instructions,
        origin: "catalogue",
        installedBy: null,
      })
      .onConflictDoUpdate({
        target: skillTable.slug,
        // See the header: only ever our own. A skill somebody wrote in this deployment keeps the
        // name, and this returns no row rather than overwriting it.
        setWhere: eq(skillTable.origin, "catalogue"),
        set: {
          title: skill.title,
          summary: skill.summary,
          instructions: skill.instructions,
          updatedAt: new Date(),
        },
      })
      .returning({ id: skillTable.id });

    if (!row) {
      skipped.push(skill.slug);
      console.warn(
        JSON.stringify({
          type: "computer-skill-skipped",
          slug: skill.slug,
          reason:
            "a skill written in this deployment already answers to that name, and it keeps it",
        }),
      );
      continue;
    }
    seeded.push(skill.slug);

    /*
     * Declared tools are cleared rather than left alone.
     *
     * These skills declare nothing today, and the comment in `computer-skills.ts` explains why that
     * is correct rather than an omission. Clearing it means a deployment that once had a declaration
     * attached to this slug — by hand, or by a future version that did declare them — does not keep
     * narrowing against refs that no longer apply. Replaced wholesale, matching the package and the
     * store's own rule.
     */
    await database.delete(skillTools).where(eq(skillTools.skillId, row.id));

    /*
     * The grant, written only where it is missing.
     *
     * `onConflictDoNothing` rather than an update: a grant carries no state worth refreshing, and a
     * restart should never be the thing that changes who a person chose to put a skill on.
     */
    if (agentId) {
      await database
        .insert(pluginGrants)
        .values({
          kind: "skill",
          ref: skill.slug,
          agentId,
          grantedBy: SEED_GRANTED_BY,
        })
        .onConflictDoNothing({
          target: [pluginGrants.kind, pluginGrants.ref, pluginGrants.agentId],
        });
    }
  }

  return { seeded, skipped };
}

/**
 * Remove the grant this module created, leaving the skills themselves alone.
 *
 * Separate from `uninstallSkill` on purpose, and the difference is the point. These are built-in
 * capabilities rather than a tenant's content: turning the computer off should withdraw the
 * instruction that says how to use it, but should not delete the skill row. If it did, the next boot
 * would put it back and the Skills page would show a skill appearing by itself after a restart.
 *
 * Nothing calls this yet — it exists so the capability has a way out that does not involve editing
 * the database by hand.
 */
export async function ungrantComputerSkills(
  database: Database,
  agentId: string,
): Promise<string[]> {
  const removed = await database
    .delete(pluginGrants)
    .where(
      and(
        eq(pluginGrants.kind, "skill"),
        eq(pluginGrants.grantedBy, SEED_GRANTED_BY),
        eq(pluginGrants.agentId, agentId),
      ),
    )
    .returning({ ref: pluginGrants.ref });
  return removed.map((row) => row.ref);
}
