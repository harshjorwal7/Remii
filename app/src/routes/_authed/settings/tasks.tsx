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
import {
  addTaskMutationOptions,
  deleteTaskMutationOptions,
  tasksQueryOptions,
  updateTaskMutationOptions,
} from "@/lib/remi";

export const Route = createFileRoute("/_authed/settings/tasks")({
  component: RouteComponent,
});

const NEXT: Record<string, { status: string; label: string } | null> = {
  OPEN: { status: "IN_PROGRESS", label: "Start" },
  IN_PROGRESS: { status: "NEEDS_REVIEW", label: "Review" },
  NEEDS_REVIEW: { status: "DONE", label: "Done" },
};

/**
 * Things to do, triaged and tracked.
 *
 * The same rows the Bot reads when it plans work. Moving one here and telling the Bot to do
 * something are the same list from opposite ends.
 */
function RouteComponent() {
  const queryClient = useQueryClient();
  const tasks = useQuery(tasksQueryOptions());
  const add = useMutation(addTaskMutationOptions(queryClient));
  const update = useMutation(updateTaskMutationOptions(queryClient));
  const remove = useMutation(deleteTaskMutationOptions(queryClient));
  const [title, setTitle] = useState("");

  return (
    <PageShell
      description="Things to do. Your Bot reads this list when it plans work and moves items along as it finishes them."
      title="Tasks"
    >
      <PageSection>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim()) return;
            add.mutate(
              { title: title.trim() },
              { onSuccess: () => setTitle("") },
            );
          }}
        >
          <Input
            aria-label="New task"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add a task…"
            value={title}
          />
          <Button disabled={add.isPending || !title.trim()} type="submit">
            Add
          </Button>
        </form>
        {tasks.isPending ? null : tasks.isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Tasks could not be loaded. Reload the page.
          </p>
        ) : (tasks.data?.tasks ?? []).length === 0 ? (
          <PageEmpty>Nothing open. Add one above or ask your Bot.</PageEmpty>
        ) : (
          <PageRows>
            {(tasks.data?.tasks ?? []).map((task) => {
              const next =
                NEXT[task.status] ?? (task.status === "DONE" ? null : null);
              return (
                <Item key={task.id} size="sm">
                  <ItemContent>
                    <ItemTitle className="font-normal">{task.title}</ItemTitle>
                    <ItemDescription>
                      {task.status.toLowerCase().replace("_", " ")} ·{" "}
                      {task.importance.toLowerCase()}
                      {task.sourceApp ? ` · ${task.sourceApp}` : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {next ? (
                      <Button
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate({ id: task.id, status: next.status })
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {next.label}
                      </Button>
                    ) : null}
                    <Button
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(task.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Delete
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
