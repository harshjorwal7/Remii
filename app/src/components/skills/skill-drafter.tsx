import {
  IconAlertCircle,
  IconBrandGithub,
  IconCheck,
  IconDownload,
  IconGitBranch,
  IconPencil,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { DraftedSkill, SkillDraft } from "@/lib/plugins/mutations";
import { draftSkillsMutationOptions } from "@/lib/plugins/mutations";
import { repoUrlRefusal } from "@/lib/skills/form";

/**
 * Paste a repository, get back the skills it contains.
 *
 * WHY IT CAN SAVE ALL SKILLS OR DRAFT THEM. A repository may define one skill or multiple skills.
 * Users can save all discovered skills in one action, save individual skills directly, or load any draft
 * into the form fields to customize it before saving.
 */
export function SkillDrafts({
  onChoose,
  saved,
  onDrafts,
  onSaveAll,
  onSaveOne,
  isSaving = false,
  savingProgress = null,
}: {
  onChoose: (draft: DraftedSkill) => void;
  /** Slugs already saved from this batch, so a second one is never offered twice. */
  saved: readonly string[];
  /**
   * What is still on offer, said upwards.
   */
  onDrafts: (drafts: readonly SkillDraft[]) => void;
  /** Save all remaining drafted skills in one batch. */
  onSaveAll?: (drafts: DraftedSkill[]) => Promise<void>;
  /** Save a single drafted skill directly. */
  onSaveOne?: (draft: DraftedSkill) => Promise<void>;
  /** Whether a batch or direct save is currently in progress. */
  isSaving?: boolean;
  /** Progress tracking for batch saves: { current, total }. */
  savingProgress?: { current: number; total: number } | null;
}) {
  const draft = useMutation(draftSkillsMutationOptions());
  const [address, setAddress] = useState("");
  const [savingSlug, setSavingSlug] = useState<string | null>(null);

  const typed = address.trim();
  const local = typed ? repoUrlRefusal(typed) : null;

  const drafts = (draft.data?.drafts ?? []).filter(
    (each) => !saved.includes(each.slug),
  );

  /*
   * THE LIST, BY ITS SLUGS.
   *
   * Keyed on slugs so parent notifications do not cause render loops.
   */
  const slugs = drafts.map((each) => each.slug).join(",");
  const lastReported = useRef<string | null>(null);
  useEffect(() => {
    if (slugs === lastReported.current) return;
    lastReported.current = slugs;
    onDrafts(drafts);
  }, [slugs, drafts, onDrafts]);

  /*
   * THE READING BELONGS TO THE ADDRESS THAT WAS READ.
   */
  const [readFor, setReadFor] = useState<string | null>(null);
  const stale = typed.length > 0 && readFor !== typed;
  const reading = draft.data && !stale ? draft.data : null;

  const handleSaveOne = async (item: SkillDraft) => {
    if (!onSaveOne) {
      onChoose({ ...item, repo: typed });
      return;
    }
    setSavingSlug(item.slug);
    try {
      await onSaveOne({ ...item, repo: typed });
    } finally {
      setSavingSlug(null);
    }
  };

  const draftsWithRepo: DraftedSkill[] = drafts.map((each) => ({
    ...each,
    repo: typed,
  }));

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border bg-card p-4 shadow-xs">
        <div className="flex items-center gap-2">
          <IconBrandGithub className="size-4 text-muted-foreground" />
          <h2 className="font-semibold text-sm">GitHub repository</h2>
        </div>
        <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
          Paste a public GitHub repository. OpenBot will inspect its{" "}
          <code>SKILL.md</code> or <code>skills/</code> folder to extract all
          defined skills.
        </p>

        <Field className="mt-3">
          <FieldLabel htmlFor="skill-draft-repo">Repository</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              aria-invalid={local !== null}
              id="skill-draft-repo"
              name="draft-repo"
              onChange={(event) => {
                setAddress(event.target.value);
                if (draft.isError) draft.reset();
              }}
              placeholder="https://github.com/owner/repo"
              spellCheck={false}
              value={address}
            />
            <Button
              disabled={
                typed.length === 0 ||
                local !== null ||
                draft.isPending ||
                isSaving
              }
              onClick={() => {
                setReadFor(typed);
                draft.mutate(typed);
              }}
              size="default"
              type="button"
              variant="outline"
            >
              <IconGitBranch className="size-4" />
              {draft.isPending ? "Reading…" : "Draft skills"}
            </Button>
          </div>
          {local ? (
            <p className="text-destructive text-sm" role="alert">
              {local}
            </p>
          ) : (
            <FieldDescription>
              Public repositories only (github.com).
            </FieldDescription>
          )}
        </Field>

        {/* The server's error response */}
        {draft.error && !stale ? (
          <div
            className="mt-3 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-2.5 text-destructive text-sm"
            role="alert"
          >
            <IconAlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{draft.error.message}</span>
          </div>
        ) : null}
      </section>

      {reading ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/40 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <IconBrandGithub className="size-4 text-muted-foreground" />
              <p className="text-xs">
                <span className="font-medium text-foreground">
                  {reading.repository.url.replace(
                    /^https:\/\/github\.com\//,
                    "",
                  )}
                </span>{" "}
                at{" "}
                <code className="font-mono text-muted-foreground">
                  {reading.repository.ref}
                </code>
                {reading.repository.truncated ? (
                  <span className="text-amber-500"> (partial file list)</span>
                ) : null}
              </p>
            </div>

            {drafts.length > 0 && onSaveAll ? (
              <Button
                disabled={isSaving || Boolean(savingSlug)}
                onClick={() => onSaveAll(draftsWithRepo)}
                size="sm"
                type="button"
                variant="default"
              >
                <IconDownload className="size-4" />
                {isSaving
                  ? `Saving ${savingProgress ? `(${savingProgress.current}/${savingProgress.total})` : "…"}`
                  : `Save all (${drafts.length}) skills`}
              </Button>
            ) : null}
          </div>

          {drafts.length === 0 ? (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
              <div className="flex size-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
                <IconCheck className="size-4" />
              </div>
              <div>
                <p className="font-medium text-sm">
                  {saved.length > 0
                    ? `All skills (${saved.length}) from this repository have been saved.`
                    : "No skills could be drafted from this repository."}
                </p>
                <p className="mt-0.5 text-muted-foreground text-xs">
                  {saved.length > 0
                    ? "You can view and manage them in your skills list."
                    : "You can write a custom skill manually using the form."}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between px-1">
                <span className="font-medium text-muted-foreground text-xs">
                  {drafts.length} skill{drafts.length === 1 ? "" : "s"} found
                </span>
              </div>

              <ul className="flex flex-col gap-2.5">
                {drafts.map((each) => {
                  const isThisSaving = savingSlug === each.slug;
                  return (
                    <li
                      className="flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-3.5 transition-colors sm:flex-row sm:items-center"
                      key={each.slug}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono font-medium text-foreground text-xs">
                            /{each.slug}
                          </code>
                          <span className="font-medium text-sm text-foreground">
                            {each.title}
                          </span>
                        </div>

                        {each.summary ? (
                          <p className="text-muted-foreground text-xs">
                            {each.summary}
                          </p>
                        ) : null}

                        <p className="text-muted-foreground text-xs">
                          {each.source ? (
                            <>
                              From <code>{each.source}</code>
                              {". "}
                            </>
                          ) : null}
                          {each.existing ? (
                            <>
                              A skill called <code>/{each.slug}</code> already
                              exists and is {each.existing} — saving this
                              replaces its text, and the server refuses if it is
                              not yours.
                            </>
                          ) : null}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {onSaveOne ? (
                          <Button
                            disabled={isSaving || isThisSaving}
                            onClick={() => handleSaveOne(each)}
                            size="sm"
                            type="button"
                            variant="default"
                          >
                            <IconDownload className="size-3.5" />
                            {isThisSaving ? "Saving…" : "Save skill"}
                          </Button>
                        ) : null}
                        <Button
                          disabled={isSaving || isThisSaving}
                          onClick={() => onChoose({ ...each, repo: typed })}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <IconPencil className="size-3.5" />
                          Use this draft
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
