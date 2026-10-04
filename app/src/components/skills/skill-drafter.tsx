import { IconSparkles } from "@tabler/icons-react";
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
 * WHY IT IS ABOVE THE FORM AND NOT A SEPARATE PAGE. The draft is not the skill — it is a proposal
 * about a skill, and the five fields below are what a person is about to save. Reading a draft
 * against the fields it will land in, in one screen, is what makes it reviewable at all; a list
 * somewhere else plus an editor somewhere else is two screens and no comparison.
 *
 * AND IT SAVES NOTHING. Every draft here goes through the same Save button as a hand-written one,
 * which is what keeps the ownership rule in one place: a slug belonging to somebody else is refused
 * by `POST /skills` whether a person typed it or a model did.
 *
 * THE ADDRESS IS CHECKED LOCALLY FIRST, and only the shapes that need no network are: `repoUrlRefusal`
 * mirrors the server's parser so a mistyped address is caught while it is typed rather than after a
 * round trip. Whether the repository exists, is public, and holds any skill file at all is GitHub's
 * to say, and it is said by the button.
 */
export function SkillDrafts({
  onChoose,
  saved,
  onDrafts,
}: {
  onChoose: (draft: DraftedSkill) => void;
  /** Slugs already saved from this batch, so a second one is never offered twice. */
  saved: readonly string[];
  /**
   * What is still on offer, said upwards.
   *
   * Here so the panel beside can decide whether the last save was the last one: a repository with
   * four skills should not close the form on the first Save and throw the other three away, and the
   * only thing that knows whether any are left is this list.
   */
  onDrafts: (drafts: readonly SkillDraft[]) => void;
}) {
  const draft = useMutation(draftSkillsMutationOptions());
  const [address, setAddress] = useState("");

  const typed = address.trim();
  const local = typed ? repoUrlRefusal(typed) : null;

  const drafts = (draft.data?.drafts ?? []).filter(
    (each) => !saved.includes(each.slug),
  );

  /*
   * THE LIST, BY ITS SLUGS.
   *
   * The filtered array is a new object every render, and saying so upwards in an effect keyed on it
   * would be a loop: parent sets state, parent re-renders, child rebuilds the array, effect fires
   * again. The slugs are what the parent actually acts on, so they are what the effect is keyed on.
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
   *
   * Held beside the mutation rather than read out of it, for the reason `SkillRepo` keeps its
   * `checkedFor`: the mutation's data is whatever the last press returned and the box holds
   * whatever was last typed, and a list of skills from a repository somebody has since replaced is
   * worse than no list.
   */
  const [readFor, setReadFor] = useState<string | null>(null);
  const stale = typed.length > 0 && readFor !== typed;
  const reading = draft.data && !stale ? draft.data : null;

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-sm">Start from a repository</h2>
      </div>
      <p className="mt-1 text-muted-foreground text-xs">
        Paste a public GitHub repository and this deployment's model will read
        the skills written in it — a <code>SKILL.md</code>, or anything under a{" "}
        <code>skills/</code> folder — and fill the fields below. One repository
        with several skills gives one draft each. Nothing is saved until you
        press Save skill.
      </p>

      <Field className="mt-3">
        <FieldLabel htmlFor="skill-draft-repo">Repository</FieldLabel>
        <div className="flex gap-2">
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
            disabled={typed.length === 0 || local !== null || draft.isPending}
            onClick={() => {
              setReadFor(typed);
              draft.mutate(typed);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconSparkles />
            {draft.isPending ? "Reading…" : "Draft skills"}
          </Button>
        </div>
        {local ? (
          <p className="text-destructive text-sm" role="alert">
            {local}
          </p>
        ) : (
          <FieldDescription>
            Public repositories only, and only github.com. Private repositories
            cannot be read here.
          </FieldDescription>
        )}
      </Field>

      {/*
       * THE SERVER'S SENTENCE, IN ITS PLACE. A private repository and a misspelled one answer GitHub
       * identically, so the sentence that says which is the useful one and it is not ours to invent.
       */}
      {draft.error && !stale ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {draft.error.message}
        </p>
      ) : null}

      {reading ? (
        <div className="mt-3">
          <p className="text-muted-foreground text-xs">
            {reading.repository.url.replace(/^https:\/\/github\.com\//, "")} at{" "}
            <code>{reading.repository.ref}</code>
            {reading.repository.truncated
              ? " — the file list is partial, so a skill file outside it was not read."
              : ""}
          </p>

          {drafts.length === 0 ? (
            <p className="mt-2 text-muted-foreground text-sm">
              {saved.length > 0
                ? "Every draft from this repository has been saved."
                : "No skills could be drafted from this repository."}{" "}
              You can still write one below.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {drafts.map((each) => (
                <li
                  className="rounded-md border border-border px-3 py-2"
                  key={each.slug}
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <code className="font-mono text-xs">/{each.slug}</code>
                    <span className="text-sm">{each.title}</span>
                  </div>
                  {each.summary ? (
                    <p className="mt-0.5 text-muted-foreground text-xs">
                      {each.summary}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-muted-foreground text-xs">
                    {each.source ? (
                      <>
                        From <code>{each.source}</code>
                        {". "}
                      </>
                    ) : null}
                    {each.existing ? (
                      <>
                        A skill called <code>/{each.slug}</code> already exists
                        and is {each.existing} — saving this replaces its text,
                        and the server refuses if it is not yours.
                      </>
                    ) : null}
                  </p>
                  <Button
                    className="mt-2"
                    onClick={() => onChoose({ ...each, repo: typed })}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Use this draft
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
