import { useMutation, useQuery } from "@tanstack/react-query";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

type InstanceChoice = {
  modelSlug: string | null;
  modelProvider: "openai" | "abliteration" | null;
};

async function loadInstance(): Promise<InstanceChoice> {
  const response = await client("/api/remi/instance", {
    fallback: "Could not load your model choice",
  });
  const body = (await response.json()) as { instance: InstanceChoice };
  return body.instance;
}

async function saveInstance(choice: InstanceChoice): Promise<InstanceChoice> {
  const response = await client("/api/remi/instance", {
    method: "PUT",
    body: choice,
    fallback: "Your model choice could not be saved",
  });
  const body = (await response.json()) as { instance: InstanceChoice };
  return body.instance;
}

const MODEL_CHOICE_KEY = ["settings", "model-choice"] as const;

/**
 * Which model answers this person's turns.
 *
 * Space Flash is the deployment default (DeepSeek flash, medium thinking); Darkside is the
 * abliterated model. Null instance fields inherit the deployment default, so "Space Flash"
 * and "use the default" are the same state and the screen says so.
 */
export function ModelChoice() {
  const stored = useQuery({
    queryKey: MODEL_CHOICE_KEY,
    queryFn: loadInstance,
  });
  const save = useMutation({
    mutationFn: saveInstance,
    onSuccess: (saved) => queryClient.setQueryData(MODEL_CHOICE_KEY, saved),
  });

  const instance = stored.data;
  const isDarkside =
    instance?.modelProvider === "abliteration" ||
    instance?.modelSlug === "abliterated-model";
  const effective: "space-flash" | "darkside" = isDarkside
    ? "darkside"
    : "space-flash";

  const choose = (next: "space-flash" | "darkside" | null) => {
    if (save.isPending) return;
    if (next === null || next === "space-flash") {
      save.mutate({ modelSlug: null, modelProvider: null });
    } else {
      save.mutate({
        modelSlug: "abliterated-model-large-v2",
        modelProvider: "abliteration",
      });
    }
  };

  return (
    <PageSection
      description="Which model answers your turns. Space Flash carries medium thinking on every turn; Darkside is the abliterated model."
      title="Model"
    >
      {stored.isPending ? null : stored.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {stored.error.message}
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex flex-row gap-2">
            <OptionButton
              active={effective === "space-flash"}
              disabled={save.isPending}
              label="Space Flash"
              onClick={() => choose("space-flash")}
            />
            <OptionButton
              active={effective === "darkside"}
              disabled={save.isPending}
              label="Darkside"
              onClick={() => choose("darkside")}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {instance?.modelProvider == null && instance?.modelSlug == null
              ? "Using the deployment default (Space Flash)."
              : effective === "space-flash"
                ? "Your own choice: Space Flash. "
                : "Your own choice: Darkside. "}
            {instance?.modelProvider != null || instance?.modelSlug != null ? (
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
