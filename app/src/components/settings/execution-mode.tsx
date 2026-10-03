import { useMutation, useQuery } from "@tanstack/react-query";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { saveExecutionModeMutationOptions } from "@/lib/settings/mutations";
import { executionModeQueryOptions } from "@/lib/settings/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * How this person's coworkers act for them: directly, or asking first.
 *
 * WHAT IT IS FOR, said on the screen. Direct means a Bot does what was asked immediately with
 * the tools it holds; ask-first means external, side-effecting actions wait for the person's
 * word first. Internal work — reading, organizing, remembering, answering — is never gated
 * either way. Null (inherited) is a real state the screen draws, not an empty one: the
 * deployment default travels beside the choice so somebody inheriting it knows what they get.
 */
export function ExecutionMode() {
  const stored = useQuery(executionModeQueryOptions());
  const save = useMutation(saveExecutionModeMutationOptions(queryClient));

  const mode = stored.data?.mode ?? null;
  const defaultMode = stored.data?.defaultMode ?? "direct";
  const effective = mode ?? defaultMode;

  const choose = (next: "direct" | "ask-first" | null) => {
    if (save.isPending) return;
    save.mutate(next);
  };

  return (
    <PageSection
      description="Whether your coworkers act directly or confirm external actions with you first. Reading, organizing, remembering and answering are never gated either way."
      title="Execution mode"
    >
      {stored.isPending ? null : stored.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {stored.error.message}
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex flex-row gap-2">
            <OptionButton
              active={effective === "direct"}
              disabled={save.isPending}
              label="Act directly"
              onClick={() => choose("direct")}
            />
            <OptionButton
              active={effective === "ask-first"}
              disabled={save.isPending}
              label="Ask first"
              onClick={() => choose("ask-first")}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {mode === null
              ? `Using the deployment default (${defaultMode === "direct" ? "act directly" : "ask first"}).`
              : "Your own choice. "}
            {mode !== null ? (
              <button
                className="underline underline-offset-2"
                disabled={save.isPending}
                onClick={() => choose(null)}
                type="button"
              >
                Use deployment default instead
              </button>
            ) : null}
          </p>
          {save.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </div>
      )}
    </PageSection>
  );
}

function OptionButton({
  active,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      className={cn(!active && "text-muted-foreground")}
      disabled={disabled}
      onClick={onClick}
      size="sm"
      type="button"
      variant={active ? "default" : "outline"}
    >
      {label}
    </Button>
  );
}
