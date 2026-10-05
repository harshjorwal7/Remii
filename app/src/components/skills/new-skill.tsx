import { IconBrandGithub, IconCode } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { SkillDrafts } from "@/components/skills/skill-drafter";
import { SkillFields } from "@/components/skills/skill-fields";
import type { DraftedSkill, SkillDraft } from "@/lib/plugins/mutations";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { emptySkillForm, type SkillFormValues } from "@/lib/skills/form";
import { cn } from "@/lib/utils";

/**
 * Writing or importing a skill in the detail panel beside the skills list.
 *
 * Provides two dedicated modes to avoid visual clutter:
 *  1. Custom skill: Write instructions manually with full control over tools and repository linkage.
 *  2. From GitHub: Inspect a public repository, draft skills automatically, and save all or individual skills with one click.
 */
export function NewSkill() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [mode, setMode] = useState<"manual" | "github">("manual");
  const createSkill = useMutation(saveSkillMutationOptions(queryClient));

  /** The fields' current contents for manual authoring. */
  const [applied, setApplied] = useState<SkillFormValues | null>(null);

  /** Slugs saved out of this repository's drafts, so none is offered twice. */
  const [saved, setSaved] = useState<string[]>([]);

  /** What the drafter still has on offer. */
  const [offered, setOffered] = useState<readonly SkillDraft[]>([]);
  const reportDrafts = useCallback(
    (drafts: readonly SkillDraft[]) => setOffered(drafts),
    [],
  );

  const [isSavingAll, setIsSavingAll] = useState(false);
  const [savingProgress, setSavingProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const choose = useCallback((draft: DraftedSkill) => {
    setApplied({
      slug: draft.slug,
      title: draft.title,
      summary: draft.summary,
      instructions: draft.instructions,
      tools: [],
      repo: draft.repo ?? null,
    });
    setMode("manual");
  }, []);

  const saveOne = useCallback(
    async (draft: DraftedSkill) => {
      await createSkill.mutateAsync({
        slug: draft.slug,
        title: draft.title,
        summary: draft.summary,
        instructions: draft.instructions,
        tools: [],
        repo: draft.repo ?? null,
      });
      setSaved((before) =>
        before.includes(draft.slug) ? before : [...before, draft.slug],
      );
    },
    [createSkill],
  );

  const saveAll = useCallback(
    async (draftsToSave: DraftedSkill[]) => {
      if (draftsToSave.length === 0) return;
      setIsSavingAll(true);
      const total = draftsToSave.length;
      setSavingProgress({ current: 0, total });

      const newlySaved: string[] = [];
      try {
        for (let i = 0; i < draftsToSave.length; i++) {
          const draft = draftsToSave[i];
          setSavingProgress({ current: i + 1, total });
          await createSkill.mutateAsync({
            slug: draft.slug,
            title: draft.title,
            summary: draft.summary,
            instructions: draft.instructions,
            tools: [],
            repo: draft.repo ?? null,
          });
          newlySaved.push(draft.slug);
        }
        setSaved((before) => [...before, ...newlySaved]);
      } finally {
        setIsSavingAll(false);
        setSavingProgress(null);
      }
    },
    [createSkill],
  );

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6 sm:p-8">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">
          {mode === "manual" ? "New skill" : "Import skills"}
        </h1>
        <p className="mt-1 text-muted-foreground text-sm leading-normal">
          {mode === "manual" ? (
            <>
              A named instruction you invoke with <code>/</code>. It goes on the
              Bots you own, and nobody else sees it.
            </>
          ) : (
            "Read skills from a public GitHub repository and save them to your Bots."
          )}
        </p>
      </header>

      {/* Segmented Mode Switcher */}
      <div className="flex rounded-lg border border-border bg-muted/50 p-1">
        <button
          className={cn(
            "flex flex-1 items-center justify-center gap-2 rounded-md py-1.5 font-medium text-xs transition-colors",
            mode === "manual"
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setMode("manual")}
          type="button"
        >
          <IconCode className="size-4" />
          Custom skill
        </button>
        <button
          className={cn(
            "flex flex-1 items-center justify-center gap-2 rounded-md py-1.5 font-medium text-xs transition-colors",
            mode === "github"
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setMode("github")}
          type="button"
        >
          <IconBrandGithub className="size-4" />
          From GitHub
        </button>
      </div>

      {mode === "github" ? (
        <SkillDrafts
          isSaving={isSavingAll}
          onChoose={choose}
          onDrafts={reportDrafts}
          onSaveAll={saveAll}
          onSaveOne={saveOne}
          saved={saved}
          savingProgress={savingProgress}
        />
      ) : (
        <SkillFields
          defaultValues={emptySkillForm}
          error={createSkill.error}
          onCancel={() => navigate({ search: {}, to: "/skills" })}
          onSubmit={async (values) => {
            await createSkill.mutateAsync(values);
            const remaining = offered.filter(
              (each) => !saved.includes(each.slug) && each.slug !== values.slug,
            );
            if (remaining.length > 0) {
              setSaved((before) => [...before, values.slug]);
              setApplied({ ...emptySkillForm });
              return;
            }
            await navigate({ search: {}, to: "/skills" });
          }}
          submitLabel="Save skill"
          values={applied ?? undefined}
        />
      )}
    </div>
  );
}
