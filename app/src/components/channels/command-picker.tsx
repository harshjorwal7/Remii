import { useQuery } from "@tanstack/react-query";
import { ComponentPreview } from "@/components/component-preview";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { commandSlug } from "@/lib/commands/slug";
import { agentComponentsQueryOptions } from "@/lib/components/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";

/**
 * What `/components` and `/repo` open.
 *
 * A chip, inserted into the draft, is the only thing a `/` command ever produces, and both of these
 * end at exactly the same place: `insertChip` on the editor, after which the composer knows nothing
 * about where the chip came from and the send path resolves it like any other command.
 *
 * The queries here are the same ones the command lists are built from, so the picker and the menu
 * can never disagree about what this Bot holds — they read one cache entry rather than asking twice.
 */

export function ComponentCommandPicker({
  agentId,
  onOpenChange,
  onPick,
  open,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The command slug, matching what `useComponentCommands` registered. */
  onPick: (slug: string) => void;
}) {
  const { data, isPending, error } = useQuery(
    agentComponentsQueryOptions(agentId),
  );
  const components = data ?? [];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Draw something</DialogTitle>
          <DialogDescription>
            Pick what this Bot should put on screen for your next message
            instead of describing it in prose.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive" role="alert">
              This Bot's components could not be loaded.
            </p>
          ) : components.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This Bot holds no components yet. A workspace administrator can
              grant them from the components gallery.
            </p>
          ) : (
            /*
             * The real component, at preview size, because the decision being made here is which
             * of these to ask for and a list of names does not tell anybody which is which.
             */
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {components.map((component) => {
                const slug = commandSlug(component.name);
                return (
                  <button
                    className="flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
                    disabled={!slug}
                    key={component.name}
                    onClick={() => {
                      onPick(slug);
                      onOpenChange(false);
                    }}
                    type="button"
                  >
                    <div className="p-3">
                      <p className="line-clamp-1 font-medium text-sm">
                        {component.title ?? component.name}
                      </p>
                      <p className="mt-1 line-clamp-2 text-muted-foreground text-xs">
                        {component.description}
                      </p>
                    </div>
                    <div className="relative h-28 border-border border-t">
                      <div className="absolute inset-3">
                        <ComponentPreview
                          kind={component.kind}
                          name={component.name}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function RepoCommandPicker({
  agentId,
  onOpenChange,
  onPick,
  open,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (slug: string) => void;
}) {
  const { data, isPending, error } = useQuery(
    agentPluginsQueryOptions(agentId),
  );
  const repos = (data?.skills ?? []).flatMap((skill) =>
    skill.repo ? [{ skill, slug: `repo-${skill.slug}` }] : [],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Answer from a repository</DialogTitle>
          <DialogDescription>
            Pick a repository for this Bot to read while it answers your next
            message.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {isPending ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive" role="alert">
              This Bot's skills could not be loaded.
            </p>
          ) : repos.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              None of this Bot's skills point at a repository. Add one on the
              skill itself.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {repos.map(({ skill, slug }) => (
                <li key={slug}>
                  <button
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
                    onClick={() => {
                      onPick(slug);
                      onOpenChange(false);
                    }}
                    type="button"
                  >
                    <p className="line-clamp-1 font-medium text-sm">
                      {skill.title}
                    </p>
                    {/*
                     * The address rather than the skill's one-liner: what is being chosen here is a
                     * place to read, and a summary of the skill would answer a different question.
                     */}
                    <p className="mt-1 line-clamp-1 text-muted-foreground text-xs">
                      {skill.repo?.url}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
