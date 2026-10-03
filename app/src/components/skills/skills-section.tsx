import { Link } from "@tanstack/react-router";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { SkillGrantToggles } from "@/components/skills/skill-grant-toggles";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import type { PluginSkill } from "@/lib/plugins/queries";

/**
 * SKILLS, WHERE A PERSON ACTUALLY LOOKS FOR THEM.
 *
 * A skill and an app connection are both "things that make a Bot able to do something I asked for", and
 * somebody setting a deployment up looks for them in the same place. They were in different places: Apps
 * listed every connector and not one skill, and the skills lived on their own page reachable only from the
 * sidebar. The result was that a deployment with seventy connector skills looked like it had none, because
 * the page a person was already on did not mention them.
 *
 * This component is the shared list, and it is shared rather than copied because there are two things
 * that must not drift:
 *
 *  - WHICH SKILLS ARE THE COMPUTER-USE ONES. They are grouped separately on both pages, and the grouping
 *    is the only thing that makes four otherwise-obscure rows findable. A second copy of that set is a
 *    second thing to forget to update, and the failure is invisible — the rows just quietly move into a
 *    list of connector workflows.
 *  - WHAT A ROW SHOWS AND WHICH AFFORDANCES IT OFFERS. In particular that a deployment skill is read-only
 *    and offers no edit menu, while offering grant switches: drawing a menu the server would refuse is a
 *    promise the page cannot keep, and refusing grants made every deployment skill inert.
 *
 * So both pages render this, and `/skills` keeps the authoring affordances — creating, editing, deleting
 * — which live in the row markup there rather than here, because "your own skill" and "the deployment's
 * skill" are genuinely different objects and only one of them is yours to change.
 */

/**
 * The computer-use slugs, mirrored from the server's `COMPUTER_SKILL_SLUGS`.
 *
 * Duplicated on purpose, and this is the one place the duplication is worth it. The server owns the
 * content and seeds it; a page only needs to know which four rows to group, and importing from `server/`
 * into the app bundle would pull a database import along with it. A stale entry can only ever move a row
 * between two sections of the same page — it cannot break a grant, hide a skill, or change what the Bot
 * is told.
 */
export const COMPUTER_SKILL_SLUGS = new Set([
  "drive-a-desktop",
  "desktop-shell-and-files",
  "browse-the-web",
  "long-desktop-tasks",
]);

/**
 * The three lists, split the same way on every page that draws them.
 *
 * `mine` needs the signed-in person's id to tell their own skills from the deployment's, which is why it
 * is a parameter and not something this file reads. Everything else is derivable from the rows.
 */
export function splitSkills(
  skills: readonly PluginSkill[],
  userId: string | undefined,
): {
  mine: PluginSkill[];
  computerUse: PluginSkill[];
  included: PluginSkill[];
} {
  const mine = skills.filter((skill) => skill.ownerUserId === userId);
  const deployment = skills.filter((skill) => skill.ownerUserId === null);
  return {
    mine,
    computerUse: deployment.filter((skill) =>
      COMPUTER_SKILL_SLUGS.has(skill.slug),
    ),
    included: deployment.filter(
      (skill) => !COMPUTER_SKILL_SLUGS.has(skill.slug),
    ),
  };
}

/** One row. `/slug` first because that is the part a person has to type. */
function SkillRow({ skill }: { skill: PluginSkill }) {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{skill.title}</ItemTitle>
        <ItemDescription>
          <code className="font-mono text-foreground/80 text-xs">
            /{skill.slug}
          </code>
          {skill.summary ? ` · ${skill.summary}` : null}
        </ItemDescription>
        {/*
         * GRANT SWITCHES ON EVERY ROW, and that is the one thing that makes a listed skill usable.
         *
         * They were absent from the deployment sections because the server refused them, on the theory
         * that a deployment skill was not the reader's to use. That conflated "whose writing is this" with
         * "whose Bot answers to whom", and its effect was that every deployment skill was listed, readable,
         * and impossible to put anywhere — the worst of the three states, since it looks like working.
         */}
        <div className="mt-2">
          <SkillGrantToggles grantedTo={skill.grantedTo} slug={skill.slug} />
        </div>
      </ItemContent>
    </Item>
  );
}

function SkillRows({ skills }: { skills: readonly PluginSkill[] }) {
  return (
    <PageRows>
      {skills.map((skill, index) => (
        <StaggerItem index={index} key={skill.id}>
          <SkillRow skill={skill} />
          {index !== skills.length - 1 && <Separator />}
        </StaggerItem>
      ))}
    </PageRows>
  );
}

/**
 * The whole skills block, minus anything the caller wants to draw itself.
 *
 * `editable` exists because the authoring page needs rows it can open, edit and delete, and duplicating
 * the row to get a menu on it would be a second row definition to keep in step. Everything here is
 * read-only; a caller that wants more renders its own rows and passes nothing.
 */
export function SkillsSection({
  skills,
  userId,
  empty,
}: {
  skills: readonly PluginSkill[];
  userId: string | undefined;
  /** Drawn when there are no skills at all. Omit to draw nothing. */
  empty?: React.ReactNode;
}) {
  const { mine, computerUse, included } = splitSkills(skills, userId);

  /*
   * NO SECTIONS AT ALL WHEN THERE IS NOTHING TO SHOW, and the caller's own empty state when it supplied
   * one. Returning the fragment directly rather than wrapping it adds no element and no key: a caller
   * that renders this inside a section of its own is drawing its heading either way, and this decides
   * only whether there are rows under it.
   */
  if (mine.length === 0 && computerUse.length === 0 && included.length === 0) {
    return empty ?? null;
  }

  return (
    <>
      {/*
       * COMPUTER USE FIRST, ABOVE EVERYTHING ELSE.
       *
       * These four decide whether Remii can work its desktop at all, and they are seeded by the server
       * rather than shipped in a tenant package — so they arrive as ordinary deployment skills and would
       * otherwise sit in a list of connector workflows nobody configured. A person whose Bot clicks at
       * coordinates it invented had no way to find the instructions that stop it doing that.
       */}
      {computerUse.length > 0 ? (
        <PageSection
          description="How Remii drives its computer: look before you act, verify what you did, and use the shell for anything that is really text. Already on Remii."
          title="Computer use"
        >
          <SkillRows skills={computerUse} />
        </PageSection>
      ) : null}

      {included.length > 0 ? (
        <PageSection
          description="Skills that came with the deployment, available to every Bot."
          title="Included skills"
        >
          <SkillRows skills={included} />
        </PageSection>
      ) : null}

      {mine.length > 0 ? (
        <PageSection
          action={
            <Link
              className="text-muted-foreground text-xs hover:text-foreground"
              search={{ new: true }}
              to="/skills"
            >
              Write a skill
            </Link>
          }
          description="Instructions you invoke with / on the Bots you own."
          title="Your skills"
        >
          <SkillRows skills={mine} />
        </PageSection>
      ) : null}
    </>
  );
}
