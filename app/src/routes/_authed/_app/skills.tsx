import { IconDots, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { DetailPanel } from "@/components/layout/detail-panel";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { EditSkill } from "@/components/skills/edit-skill";
import { NewSkill } from "@/components/skills/new-skill";
import { SkillGrantToggles } from "@/components/skills/skill-grant-toggles";
import { SkillRepoFreshness } from "@/components/skills/skill-repo";
import { splitSkills } from "@/components/skills/skills-section";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  refreshSkillRepoMutationOptions,
  removeSkillMutationOptions,
} from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * Personal `/` skills. They are instructions, not capabilities, and can only be granted to Bots the
 * signed-in user owns.
 */

/**
 * Writing a skill is a search parameter rather than a route, so the list stays on screen behind the
 * panel and the form is linkable, reloadable, and closed by Back — the same contract the agents
 * roster makes.
 */
const skillsSearchSchema = z.object({
  new: z.boolean().optional(),
  /** The slug being edited. Absent means nothing is. */
  edit: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/skills")({
  validateSearch: skillsSearchSchema,
  component: SkillsPage,
});

function SkillsPage() {
  const queryClient = useQueryClient();
  const { new: isCreating, edit: editingSlug } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Creating wins if both are somehow set: it is the more recent intent, the same rule the agents
  // roster uses when `new` and `agent` arrive together.
  const showCreate = isCreating === true;
  const showEdit = !showCreate && editingSlug !== undefined;
  const {
    data,
    isPending: skillsPending,
    isError: skillsFailed,
  } = useQuery(pluginsPageQueryOptions());
  const { data: me, isPending: mePending } = useQuery(
    currentUserQueryOptions(),
  );
  /*
   * Both, because `mine` is the intersection of the two: until the person is known, nothing matches
   * them and the list is empty for a reason that is not "you have no skills".
   */
  const loading = skillsPending || mePending;
  const [error, setError] = useState<string | null>(null);

  const removeSkill = useMutation({
    ...removeSkillMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => setError(null),
  });

  /*
   * ONE MUTATION FOR EVERY ROW, with the slug in its variables.
   *
   * A row that pressed its own mutation would make the handler a closure per skill, and the interesting
   * state — which skill is being read, and did GitHub refuse it — would live in the row rather than on
   * this screen. One pending flag and one refusal here means the message is drawn on the row that caused
   * it, and nobody is told about it beside a repository they did not press.
   *
   * WHICH SKILL IS BEING READ, read off the mutation rather than held beside it — and by slug, because
   * two skills may point at the same repository and reading one of them says nothing about the other.
   */
  const readAgain = useMutation(refreshSkillRepoMutationOptions(queryClient));
  const readingSlug = readAgain.isPending
    ? (readAgain.variables ?? null)
    : null;
  const repoRefusal =
    readAgain.error instanceof Error ? readAgain.error.message : null;

  /*
   * The server has ALREADY excluded skills this person may not see — `listSkills` scopes the query
   * to `owner_user_id is null or owner_user_id = me`, so somebody else's private skill is never read
   * into the process. These two lines only sort what arrived into the two things the page draws.
   *
   * Individual-user SaaS has no administrator and no cross-user reads: the server scopes the
   * query to `owner_user_id is null or owner_user_id = me`, so what arrived is this person's own
   * skills plus the deployment's templates, and nothing of anybody else's.
   */
  const skills = data?.skills ?? [];
  /*
   * THROUGH THE SHARED SPLIT, not a copy of it.
   *
   * The grouping is the thing that must not drift: four computer-use rows are only findable because they
   * are pulled out of a list of connector workflows, and the Apps page now groups them the same way. Two
   * copies of that set is two things to forget, and the failure is silent — the rows simply move into a
   * list nobody recognises.
   */
  const {
    mine,
    computerUse,
    included: otherDeployment,
  } = splitSkills(skills, me?.id);
  /*
   * The computer-use skills, split out of the deployment list.
   *
   * They are seeded by the server rather than shipped in a tenant package (see
   * `computer-skill-seed.ts` for why they cannot be), so they arrive here as ordinary deployment
   * skills and would sit in a list headed "Included skills" underneath seventy connector skills a
   * person has never configured. That is a bad home for the one set of instructions that decides
   * whether the Bot can drive its computer at all — and the four of them are the answer to "how do I
   * make Remii use the computer properly", which is a question this page should visibly answer.
   *
   * Split by slug rather than by a new column because there is nothing else to distinguish them by:
   * they are the same kind of row as every other deployment skill, and adding a `kind` to the schema
   * to group four rows on one screen is a worse trade than listing four slugs.
   */

  return (
    <DetailPanel
      detail={
        showCreate ? (
          <NewSkill />
        ) : editingSlug ? (
          <EditSkill slug={editingSlug} />
        ) : null
      }
      onClose={() => navigate({ search: {} })}
      open={showCreate || showEdit}
    >
      <PageShell
        description={
          <>
            A skill is a named instruction you invoke with <code>/</code> and a
            Bot follows. Yours are yours alone, and go on the Bots you own.
          </>
        }
        title="Agent Skills"
      >
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <PageSection
          action={
            <Button
              render={(props) => (
                <Link search={{ new: true }} to="/skills" {...props} />
              )}
              size="sm"
              variant="ghost"
            >
              <IconPlus />
              New skill
            </Button>
          }
          title="Your skills"
        >
          {/*
           * Nothing while the two queries are still in flight. The alternative is the empty state
           * standing there saying this person has written no skills, which is a claim the page has
           * not yet earned.
           */}
          {/*
           * A FAILED READ IS NOT AN EMPTY LIST.
           *
           * `loading` goes false on failure, `data` is then undefined, `skills` is `[]`, and
           * "You don't have any skills yet" is drawn for a person who has some. That is not only
           * wrong, it is expensive: a slug looks free, so they write a second skill with the same
           * one. The agents roster already narrows on `failed && data === undefined` for exactly
           * this, and this screen is the one that had not.
           */}
          {loading ? null : skillsFailed && data === undefined ? (
            <p className="text-muted-foreground mt-4 text-sm" role="alert">
              Your skills could not be loaded. Reload to try again.
            </p>
          ) : mine.length === 0 ? (
            <Empty className="mt-4 h-[180px] border border-dashed">
              <EmptyHeader>
                <EmptyTitle className="text-muted-foreground">
                  You don't have any skills yet.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <PageRows>
              {mine.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{skill.title}</ItemTitle>
                      {/*
                       * THE COMMAND FIRST, because it is the only part a person has to know. The title
                       * says what the skill is for; `/slug` is what they actually type, and a page that
                       * lists skills without showing how to invoke one leaves them guessing at it.
                       *
                       * The interpunct only appears when there is a summary to separate it from —
                       * a trailing "· " on a skill written without one reads as something missing.
                       */}
                      <ItemDescription>
                        <code className="font-mono text-foreground/80 text-xs">
                          /{skill.slug}
                        </code>
                        {skill.summary ? ` · ${skill.summary}` : null}
                      </ItemDescription>
                      {/*
                       * ON THE ROW, NOT ONLY IN THE EDIT PANEL.
                       *
                       * Grant switches used to exist only inside the edit form, which made the most
                       * consequential act in this page — deciding which Bots can use a skill — hidden
                       * behind a dropdown and then a Save. A skill listed with nothing next to it
                       * looked equally available on every Bot it was not on. On the row, "which Bots
                       * carry this" is answerable without opening anything.
                       */}
                      <div className="mt-2">
                        <SkillGrantToggles
                          grantedTo={skill.grantedTo}
                          slug={skill.slug}
                        />
                      </div>
                      {/*
                       * WHERE THE CODE IS, AND HOW STALE THE READING OF IT IS.
                       *
                       * On the row rather than only in the edit form, for the reason the grant switches
                       * are: a skill pointing at a repository is a fact about what a Bot will be able to
                       * read, and a person deciding which skills to put on a Bot should not have to open
                       * anything to find out. The button is here rather than nowhere because this is
                       * the author's own skill, so the server will let them read it again.
                       */}
                      {skill.repo ? (
                        <div className="mt-2">
                          <SkillRepoFreshness
                            error={
                              readingSlug === skill.slug ? repoRefusal : null
                            }
                            fileCount={skill.repo.fileCount}
                            indexedAt={skill.repo.indexedAt}
                            onRefresh={() => readAgain.mutate(skill.slug)}
                            refreshing={readingSlug === skill.slug}
                            truncated={skill.repo.truncated}
                            url={skill.repo.url}
                          />
                        </div>
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button variant="ghost" size="icon-sm">
                              <IconDots />
                            </Button>
                          }
                        ></DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onClick={() =>
                                navigate({ search: { edit: skill.slug } })
                              }
                            >
                              Edit
                            </DropdownMenuItem>
                            {/*
                             * Deleting is immediate and there is no undo. It is behind a menu rather
                             * than sitting on the row for that reason, and the slug is named in the
                             * label so the destructive item says WHICH skill it destroys — a menu
                             * opened over the wrong row is the ordinary way this goes wrong.
                             */}
                            <DropdownMenuItem
                              onClick={() => {
                                setError(null);
                                removeSkill.mutate(skill.slug);
                              }}
                              variant="destructive"
                            >
                              Delete /{skill.slug}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </ItemActions>
                  </Item>
                  {index !== mine?.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          )}
        </PageSection>

        {/*
         * THE COMPUTER-USE SKILLS, ABOVE EVERYTHING ELSE ON THE PAGE.
         *
         * These four are what decide whether Remii can work its desktop at all, and they used to be
         * invisible: they are seeded by the server rather than shipped in a tenant package, so they
         * arrived as ordinary deployment skills and sat in a list of connector workflows nobody had
         * configured. A person whose Bot clicks at coordinates it invented had no way to find the
         * instructions that stop it doing that.
         *
         * Read-only, like every deployment skill, and for the same reason the server enforces: they
         * are not editable, they cannot be deleted, and the edit menu here would be a promise the
         * server refuses. What they CAN do is be put on a Bot, which is why these rows carry grant
         * switches and the other two sections did not.
         */}
        {computerUse.length > 0 ? (
          <PageSection
            description="How Remii drives its computer: look before you act, verify what you did, and use the shell for anything that is really text. Already on Remii."
            title="Computer use"
          >
            <PageRows>
              {computerUse.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{skill.title}</ItemTitle>
                      <ItemDescription>
                        <code className="font-mono text-foreground/80 text-xs">
                          /{skill.slug}
                        </code>
                        {skill.summary ? ` · ${skill.summary}` : null}
                      </ItemDescription>
                      <div className="mt-2">
                        <SkillGrantToggles
                          grantedTo={skill.grantedTo}
                          slug={skill.slug}
                        />
                      </div>
                    </ItemContent>
                  </Item>
                  {index !== computerUse.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          </PageSection>
        ) : null}

        {/*
         * NO MENU ON THESE ROWS, AND THAT IS THE POINT. A skill that belongs to the deployment rather
         * than to the person reading this page cannot be edited or deleted from here: they are
         * read-only templates the deployment ships. Drawing the same dropdown and refusing on click
         * would be a worse answer than not offering it — the server refuses either way, and an
         * affordance that only ever fails is a promise the page cannot keep.
         *
         * Grant switches ARE drawn, which is the one thing that changed here. They used to be absent
         * because the server refused them: a skill with no owner was refused outright, on the theory
         * that a deployment skill was not the reader's to use. That conflated "whose writing is this"
         * with "whose Bot answers to whom", and it made every deployment skill inert — listed,
         * readable, and impossible to put anywhere. The server now refuses only a skill that belongs
         * to somebody ELSE, and still requires the Bot to be the reader's own.
         *
         * Hidden entirely when there are none, rather than shown empty: no shared skills yet
         * is the normal case, and a permanently empty section reads as broken.
         */}
        {otherDeployment.length > 0 ? (
          <PageSection
            description="Skills that came with the deployment, available to every Bot."
            title="Included skills"
          >
            <PageRows>
              {otherDeployment.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{skill.title}</ItemTitle>
                      {/*
                       * THE COMMAND FIRST, because it is the only part a person has to know. The title
                       * says what the skill is for; `/slug` is what they actually type, and a page that
                       * lists skills without showing how to invoke one leaves them guessing at it.
                       *
                       * The interpunct only appears when there is a summary to separate it from —
                       * a trailing "· " on a skill written without one reads as something missing.
                       */}
                      <ItemDescription>
                        <code className="font-mono text-foreground/80">
                          /{skill.slug}
                        </code>
                        {skill.summary ? ` · ${skill.summary}` : null}
                      </ItemDescription>
                      <div className="mt-2">
                        <SkillGrantToggles
                          grantedTo={skill.grantedTo}
                          slug={skill.slug}
                        />
                      </div>
                      {/*
                       * The same line as an owned row, WITHOUT the button, and that difference is the
                       * point. A deployment skill may point at a repository — a tenant package can ship
                       * one, and it is how a packaged skill arrives with the codebase it is about — but
                       * only its author may read it again, and drawing a control that could only fail
                       * is the affordance this page has decided not to offer.
                       */}
                      {skill.repo ? (
                        <div className="mt-2">
                          <SkillRepoFreshness
                            fileCount={skill.repo.fileCount}
                            indexedAt={skill.repo.indexedAt}
                            truncated={skill.repo.truncated}
                            url={skill.repo.url}
                          />
                        </div>
                      ) : null}
                    </ItemContent>
                  </Item>
                  {index !== otherDeployment.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          </PageSection>
        ) : null}
      </PageShell>
    </DetailPanel>
  );
}
