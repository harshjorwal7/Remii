import {
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef } from "react";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * Creating and inspecting a coworker are search-parameter states so the roster remains mounted and
 * Back closes the dialog.
 */
const agentsSearchSchema = z.object({
  new: z.boolean().optional(),
  agent: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: agentsSearchSchema,
  component: AgentsScreen,
});

/*
 * Two different rosters, laid out two different ways, and the reason is what each one contains.
 *
 * "Your agents" is `grid-cols-2 sm:grid-cols-4` of full-width cards that fill their track. A fixed
 * column count is safe here precisely because the card is fluid: a card is never wider than the
 * track it is in, so nothing can overlap however narrow this column gets — including when opening
 * the detail pane takes the width out of it at any window size. (This used to be fixed-width cards
 * in `auto-fill` tracks, and that combination overlapped behind an open Bot.)
 *
 * "Explore agents" is the opposite: a `flex` row of cards at a fixed `w-[170px]` that scrolls
 * sideways. Those are template previews in a strip, not a grid to be read across, so they keep
 * their size and the row scrolls rather than reflowing to two columns.
 *
 * Both are block children of their section and must stay that way. A grid placed inside a
 * `flex flex-row` is a flex item sized shrink-to-fit, which is what put "Your agents" into a
 * one-card column while "Explore agents" flowed correctly three across on the very same page. Do
 * not reintroduce a flex wrapper to position either roster.
 */
function AgentsScreen() {
  const { new: isCreating, agent: selectedAgentId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const templatesScrollRef = useRef<HTMLDivElement>(null);

  const scrollTemplates = (direction: "left" | "right") => {
    templatesScrollRef.current?.scrollBy({
      left: direction === "left" ? -360 : 360,
      behavior: "smooth",
    });
  };
  /*
   * The two empty states below must not fire while the list is still arriving. `skills.tsx` learned
   * this first: an empty state standing there saying somebody has created nothing is a claim the
   * screen has not yet earned, and on a slow connection it is the first thing they read.
   *
   * `isPending` rather than `agents === undefined`, and the difference is the whole point on a
   * screen whose job is to say when there is nothing. `data` is also undefined when the query
   * FAILED, so deriving the flag from it holds the screen in its loading branch forever on an
   * error — two headings over nothing, which is the exact shape this task exists to remove.
   * `isPending` goes false either way, so a failure falls through to the empty state.
   */
  const {
    data: agents,
    isPending: loading,
    isError: failed,
  } = useQuery(agentListQueryOptions());
  const templates = agents?.filter((a) => Boolean(a.isSystemTemplate));
  const mine = agents?.filter((a) => !a.isSystemTemplate && a.mine);
  // Strict per-user SaaS sandbox: public sharing is removed, so there is no
  // "shared with you" roster. Templates are deployment definitions (no user
  // data); everything else is the user's own private agents.

  // Creating wins if both are somehow set: it is the more recent intent.
  const showCreate = isCreating === true;
  const showProfile = !showCreate && selectedAgentId !== undefined;
  const close = () => navigate({ search: {} });

  return (
    <>
      <SidebarToggleBar />
      <div className="max-w-3xl px-4 w-full mx-auto pb-12">
        <div className="mt-12 w-full max-w-3xl">
          <div className="flex flex-row w-full items-center justify-between">
            <h2 className="font-bold text-lg">Your agents</h2>
            <Button
              variant="ghost"
              size="sm"
              render={(props) => (
                <Link to="/agents" search={{ new: true }} {...props} />
              )}
            >
              <IconPlus />
              New agent
            </Button>
          </div>
          {loading ? (
            // Reserves the same 180px the settled arms below occupy, so this section holds its
            // own height and the page beneath it does not jump when the query settles.
            <Skeleton className="mt-4 h-[180px]" />
          ) : mine?.length ? (
            // Wins over `failed`: TanStack Query keeps the last good `data` across a failed
            // background refetch (see query-core's error action — it spreads `...state` and
            // never clears `data`), so `isError` and a still-populated roster are an ordinary
            // combination, not a contradiction. A stale roster beats an error card claiming
            // there is nothing, which would be false here.
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4 w-full">
              {mine.map((agent, index) => {
                return (
                  <StaggerItem index={index} key={agent.id}>
                    <Link to="/agents" search={{ agent: agent.id }}>
                      <AgentCard agent={agent} />
                    </Link>
                  </StaggerItem>
                );
              })}
            </div>
          ) : failed && agents === undefined ? (
            // `agents === undefined` narrows this to "the query has never once returned
            // successfully" — not merely "the last request errored". `?.length` alone can't
            // tell that apart from a slice that loaded and is genuinely empty: TanStack Query
            // never clears `data` on a failed background refetch, so once the query has
            // resolved even one response, `agents` stays defined and `mine`'s emptiness is a
            // fact about that response, not a symptom of the failure. Rendering the destructive
            // card there would say the opposite of what "Explore agents" beside it (or this
            // section itself, on a different roster) proves by rendering real cards from the
            // same query.
            <Empty className="mt-4 h-[180px] border border-dashed border-destructive">
              <EmptyHeader>
                <EmptyTitle className="text-destructive">
                  Your agents couldn't be loaded.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            // Reached both when the query never failed and `mine` is genuinely empty, and when
            // it failed but `agents` is defined — a loaded, empty slice either way. Same plain
            // copy for both: an empty roster is a fact, not an error.
            <Empty className="mt-4 h-[180px] border border-dashed">
              <EmptyHeader>
                <EmptyTitle className="text-muted-foreground">
                  You don't have any agents created.
                </EmptyTitle>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  render={(props) => (
                    <Link to="/agents" search={{ new: true }} {...props} />
                  )}
                >
                  <IconPlus />
                  New agent
                </Button>
              </EmptyHeader>
            </Empty>
          )}
        </div>

        {Boolean(templates?.length) && (
          <div className="mt-8 w-full max-w-3xl">
            <div className="flex flex-row w-full items-center justify-between gap-4">
              <div>
                <h2 className="font-bold text-lg">Templates</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Pre-configured agents for common workflows like research,
                  coding, and job hunting. Starting one makes your own private
                  copy — your data never mixes with anyone else's.
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => scrollTemplates("left")}
                  aria-label="Scroll left"
                >
                  <IconChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => scrollTemplates("right")}
                  aria-label="Scroll right"
                >
                  <IconChevronRight className="size-4" />
                </Button>
              </div>
            </div>
            <div
              ref={templatesScrollRef}
              className="mt-4 flex gap-4 overflow-x-auto pb-4 pt-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              {templates?.map((agent, index) => (
                <StaggerItem
                  className="w-[170px] shrink-0"
                  index={index}
                  key={agent.id}
                >
                  <Link to="/agents" search={{ agent: agent.id }}>
                    <AgentCard agent={agent} />
                  </Link>
                </StaggerItem>
              ))}
            </div>
          </div>
        )}
      </div>
      <CreateAgentDialog
        onClose={close}
        onCreated={(agentId) => navigate({ search: { agent: agentId } })}
        open={showCreate}
      />
      <AgentDialog
        agentId={selectedAgentId ?? null}
        onClose={close}
        open={showProfile}
      />
    </>
  );
}
