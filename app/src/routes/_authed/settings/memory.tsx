import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import {
  artifactsQueryOptions,
  deleteMemoryMutationOptions,
  memoriesQueryOptions,
  memorySearchQueryOptions,
  memoryStatsQueryOptions,
  patchMemoryMutationOptions,
} from "@/lib/remi";

export const Route = createFileRoute("/_authed/settings/memory")({
  component: RouteComponent,
});

/**
 * What the Bot remembers about you.
 *
 * The same rows its memory_search reads: durable facts, preferences and decisions it saved
 * across conversations — plus what it recalled on its own, when it mattered, and what it
 * chose to forget. Forgetting one here removes it from every future answer too.
 */
function RouteComponent() {
  const queryClient = useQueryClient();
  const memories = useQuery(memoriesQueryOptions());
  const stats = useQuery(memoryStatsQueryOptions());
  const briefings = useQuery(artifactsQueryOptions());
  const forget = useMutation(deleteMemoryMutationOptions(queryClient));
  const patch = useMutation(patchMemoryMutationOptions(queryClient));
  const [search, setSearch] = useState("");
  const searched = useQuery(memorySearchQueryOptions(search));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const rows = memories.data?.memories ?? [];
  const shown =
    search.trim().length > 1 && searched.data
      ? rows.filter((row) =>
          searched.data.memories.some((hit) => hit.id === row.id),
        )
      : rows;
  const briefs = (briefings.data?.artifacts ?? []).filter((artifact) =>
    artifact.name.startsWith("briefing-"),
  );
  const recalled =
    stats.data?.events.find((event) => event.kind === "recalled")?.count ?? 0;
  const cited =
    stats.data?.events.find((event) => event.kind === "cited")?.count ?? 0;

  return (
    <PageShell
      description="Durable facts your Bot remembers across conversations. It recalls these on its own when they matter."
      title="Memory"
    >
      <PageSection>
        <Input
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search what is remembered…"
          value={search}
        />
        {stats.data ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {rows.length} remembered · recalled {recalled}× in the last 30 days
            {cited > 0 ? `, visibly used ${cited}×` : ""}
          </p>
        ) : null}
      </PageSection>
      {memories.isPending ? null : memories.isError ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Memories could not be loaded. Reload the page.
        </p>
      ) : (
        <PageSection>
          {shown.length === 0 ? (
            <PageEmpty>
              {search.trim()
                ? "Nothing remembered matches that search."
                : "Nothing remembered yet. Ask your Bot to remember something and it appears here."}
            </PageEmpty>
          ) : (
            <PageRows>
              {shown.map((memory) => (
                <Item key={memory.id} size="sm">
                  <ItemContent>
                    {editingId === memory.id ? (
                      <Textarea
                        autoFocus
                        onChange={(event) => setDraft(event.target.value)}
                        rows={3}
                        value={draft}
                      />
                    ) : (
                      <ItemTitle className="font-normal">
                        {memory.content}
                      </ItemTitle>
                    )}
                    <ItemDescription>
                      {memory.scope} · importance {memory.importance}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {editingId === memory.id ? (
                      <>
                        <Button
                          disabled={patch.isPending}
                          onClick={() => {
                            if (!draft.trim()) return;
                            patch.mutate(
                              { id: memory.id, content: draft.trim() },
                              { onSuccess: () => setEditingId(null) },
                            );
                          }}
                          size="sm"
                          type="button"
                        >
                          Save
                        </Button>
                        <Button
                          onClick={() => setEditingId(null)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          disabled={forget.isPending || patch.isPending}
                          onClick={() => {
                            setEditingId(memory.id);
                            setDraft(memory.content);
                          }}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Correct
                        </Button>
                        <Button
                          disabled={forget.isPending || patch.isPending}
                          onClick={() => forget.mutate(memory.id)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Forget
                        </Button>
                      </>
                    )}
                  </ItemActions>
                </Item>
              ))}
            </PageRows>
          )}
        </PageSection>
      )}
      {briefs.length > 0 ? (
        <PageSection>
          <h2 className="font-bold text-lg">Morning briefs</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            What your Bot set out for you each morning, from open work and what
            it remembers.
          </p>
          <PageRows>
            {briefs.map((brief) => (
              <Item key={brief.id} size="sm">
                <ItemContent>
                  <ItemTitle className="font-normal">{brief.name}</ItemTitle>
                </ItemContent>
              </Item>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
