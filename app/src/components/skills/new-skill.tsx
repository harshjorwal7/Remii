import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { SkillDrafts } from "@/components/skills/skill-drafter";
import { SkillFields } from "@/components/skills/skill-fields";
import type { DraftedSkill, SkillDraft } from "@/lib/plugins/mutations";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { emptySkillForm, type SkillFormValues } from "@/lib/skills/form";

/**
 * Writing a skill, in the detail panel beside the list.
 *
 * The panel rather than a page of its own, so the skills you already have stay on screen while you
 * write the next one — the usual reason to open this is to make a variant of one that exists.
 *
 * TWO WAYS IN, ONE WAY OUT. A person can type a skill into the fields, or paste a repository above
 * them and have one drafted into the same fields. Both are reviewed in the same place and both are
 * saved by the same button, because a draft that arrived by itself is not a skill and a review that
 * happens somewhere else is not a review.
 */
export function NewSkill() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const createSkill = useMutation(saveSkillMutationOptions(queryClient));

  /**
   * The fields' current contents, as handed down from above.
   *
   * Held here rather than in the drafter because the two halves have to agree on it: choosing a
   * draft sets it, and saving the draft that was in the fields has to know which slug that was.
   */
  const [applied, setApplied] = useState<SkillFormValues | null>(null);

  /** Slugs saved out of this repository's drafts, so none is offered twice. */
  const [saved, setSaved] = useState<string[]>([]);

  /** What the drafter still has on offer, so the last save can be told from the first. */
  const [offered, setOffered] = useState<readonly SkillDraft[]>([]);
  const reportDrafts = useCallback(
    (drafts: readonly SkillDraft[]) => setOffered(drafts),
    [],
  );

  const choose = useCallback((draft: DraftedSkill) => {
    /*
     * A NEW OBJECT EVERY TIME, because `SkillFields` resets on identity rather than on contents:
     * handing the same object back would mean pressing the same draft twice does nothing at all,
     * which reads as a broken button rather than as a no-op.
     */
    setApplied({
      slug: draft.slug,
      title: draft.title,
      summary: draft.summary,
      instructions: draft.instructions,
      // Tools are left to the person: a declaration is theirs to make, and the picker is right here.
      tools: [],
      repo: draft.repo ?? null,
    });
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">New skill</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A named instruction you invoke with <code>/</code>. It goes on the
          Bots you own, and nobody else sees it.
        </p>
      </header>

      <SkillDrafts onChoose={choose} onDrafts={reportDrafts} saved={saved} />

      <SkillFields
        defaultValues={emptySkillForm}
        error={createSkill.error}
        onSubmit={async (values) => {
          await createSkill.mutateAsync(values);
          /*
           * THE PANEL STAYS OPEN WHILE A REPOSITORY STILL OWES SKILLS.
           *
           * It used to close on every save, which is right for a hand-written skill and wrong for a
           * repository with four: three drafts would be thrown away by the save that succeeded, and
           * the person would have to re-read the repository to get them back. So the close happens
           * when there is nothing left on offer, and until then the form empties and the next draft
           * is not loaded for them — the choice of which draft to save next is theirs.
           */
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
    </div>
  );
}
