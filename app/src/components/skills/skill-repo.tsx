import { IconRefresh } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { previewRepoMutationOptions } from "@/lib/plugins/mutations";
import { repoUrlRefusal, splitRepoUrl } from "@/lib/skills/form";

/**
 * The public repository a skill is about, as one field.
 *
 * WHY IT IS ONE FIELD AND NOT THREE. A repository is one thing a person names, and the branch and the
 * folder are parts of its address rather than separate decisions. Somebody pasting the address out of
 * a browser — which is what `github.com/owner/repo/tree/main/packages/api` is, and it is what the
 * address bar holds for a folder inside a monorepo — should get that repository, that branch and that
 * folder without having to notice they pasted all three. So the field takes the address and the server
 * parses it, and what this screen shows afterwards is the split.
 *
 * WHY IT IS NOT A GRANT. The repository is content the skill carries, the way its instruction is, and
 * adding it adds no tool and reaches nothing with a credential behind it — it is code published to be
 * read. That is the argument that lets anybody signed in fill this in rather than an administrator,
 * and it holds only while it stays public, which is why the server accepts nothing but a github.com
 * address and stores no token. See `plugins/repo-index.ts`.
 *
 * WHAT A BOT GAINS BY HAVING IT. Three tools — an overview, a search, and one file at a time — bound to
 * this repository and offered only while the Bot carries this skill. Nothing is reachable by knowing
 * the address: every read is gated on the skill being granted to that Bot, on the server, again.
 *
 * THE CHECK BUTTON, and why there is one. Everything locally checkable about an address is checked
 * while it is typed, and everything that is not is what this asks GitHub: that the repository exists,
 * that it is public, and that the folder inside it is there. A private repository and a misspelled one
 * answer GitHub identically, and that is a sentence only GitHub can give — so this is the one place the
 * screen spends a request, and pressing Save spends none.
 */
export function SkillRepo({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
}) {
  const preview = useMutation(previewRepoMutationOptions());

  /*
   * Only what can be decided without asking anybody. `splitRepoUrl` mirrors the server's parser and
   * agrees with it about the shapes above; anything it is unsure about is left to the Check button,
   * because a locally-invented "that is not a repository" on an address the server would have read is
   * the one failure this screen must not have.
   */
  const typed = (value ?? "").trim();
  const local = typed ? repoUrlRefusal(typed) : null;
  const split = typed && !local ? splitRepoUrl(typed) : null;

  /*
   * WHICH ADDRESS THE READING BELOW IS ABOUT.
   *
   * Held beside the mutation rather than read out of it, because the two answer different questions:
   * the mutation's data is whatever the last press returned, and the field is whatever was last typed.
   * Comparing them on every render is how a stale "42 files" ends up drawn under an address somebody
   * has since replaced — so the press records what it checked, editing clears it, and the reading is
   * drawn only while the two agree.
   */
  const [checkedFor, setCheckedFor] = useState<string | null>(null);
  const readingStale = typed.length > 0 && checkedFor !== typed;

  return (
    <Field>
      <FieldLabel htmlFor="skill-repo">Repository</FieldLabel>

      <div className="flex gap-2">
        <Input
          aria-invalid={local !== null}
          id="skill-repo"
          name="repo"
          onBlur={(event) => {
            /*
             * TRIMMED ON BLUR, because the shape of the stored value is the server's parser and a
             * trailing space from a paste is not part of it. The raw text is kept while the field has
             * focus so that a half-typed address is not rewritten under the cursor.
             */
            const next = event.target.value.trim();
            onChange(next.length === 0 ? null : next);
          }}
          onChange={(event) => {
            setCheckedFor(null);
            preview.reset();
            onChange(
              event.target.value.trim().length === 0
                ? null
                : event.target.value,
            );
          }}
          placeholder="https://github.com/owner/repo"
          spellCheck={false}
          value={value ?? ""}
        />
        <Button
          disabled={typed.length === 0 || local !== null || preview.isPending}
          onClick={() => {
            setCheckedFor(typed);
            preview.mutate(typed);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {preview.isPending ? "Checking…" : "Check"}
        </Button>
      </div>

      {local ? (
        <p className="text-sm text-destructive" role="alert">
          {local}
        </p>
      ) : split ? (
        <FieldDescription>
          Reads{" "}
          <code>
            {split.owner}/{split.repo}
          </code>
          {split.ref ? (
            <>
              {" "}
              at <code>{split.ref}</code>
            </>
          ) : (
            " at its default branch"
          )}
          {split.path ? (
            <>
              {" "}
              in <code>{split.path}</code>
            </>
          ) : null}
          .
        </FieldDescription>
      ) : (
        <FieldDescription>
          A public GitHub repository. Optional — a skill can still be only
          instructions. A branch or folder can be included:{" "}
          <code>github.com/owner/repo/tree/main/packages/api</code>.
        </FieldDescription>
      )}

      {/*
       * THE READING, OR WHY THERE IS NOT ONE. A person who is about to attach a codebase to a skill
       * deserves to know GitHub could actually read it, and deserves the failure in GitHub's words when
       * it could not — a private repository and a mistyped owner are indistinguishable locally, and the
       * sentence that tells them so is the useful one.
       *
       * Nothing is shown while the box no longer holds what was checked, because a reading of a
       * different repository is worse than no reading at all.
       */}
      {preview.error && !readingStale ? (
        <p className="text-sm text-destructive" role="alert">
          {preview.error.message}
        </p>
      ) : null}
      {preview.data && !readingStale ? (
        <p className="text-muted-foreground text-xs">
          {preview.data.repository.description ?? "No description on GitHub."}{" "}
          {preview.data.repository.language
            ? `Mostly ${preview.data.repository.language}. `
            : ""}
          {preview.data.repository.fileCount.toLocaleString()} files on{" "}
          <code>{preview.data.repository.ref}</code>.{/*
           * Said here rather than left for a Bot to assume. Past this cap the file list is partial, and
           * a partial list presented as the whole repository is how "that file does not exist" gets
           * reported about a file that does.
           */}
          {preview.data.repository.truncated
            ? " That is more than fits here, so the list is partial — point at a folder inside it to see all of it."
            : ""}
        </p>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Public code only. Picking this skill is what offers the Bot the tools
        that read it — it grants nothing by itself, and the Bot reads nothing
        belonging to a skill it was not granted.
      </p>
    </Field>
  );
}

/**
 * The repository's own freshness, on the Skills page rather than only in the form.
 *
 * Separate from the form above because it answers a question about the skill as it stands, not about
 * what is being typed: a skill saved three days ago against a branch that has moved since is a skill
 * quietly answering from code that is no longer there, and the person who can act on that is the one
 * who wrote it.
 *
 * The Read again button is a prop rather than a button because a deployment's own skills carry a
 * repository too and cannot be refreshed from here — the server refuses anything but the author's —
 * and drawing a control that could only ever fail is the thing `skills.tsx` says it will not do.
 */
export function SkillRepoFreshness({
  url,
  indexedAt,
  truncated,
  fileCount,
  onRefresh,
  refreshing,
  error,
}: {
  url: string;
  indexedAt: string | null;
  truncated: boolean;
  fileCount: number | null;
  /** Absent on a skill this person may read but not rewrite. */
  onRefresh?: () => void;
  refreshing?: boolean;
  error?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
      <span>
        Reads <code>{url.replace(/^https:\/\/github\.com\//, "")}</code>
      </span>
      {/*
       * THREE STATES, AND "NOT READ YET" IS NOT ONE OF THEM BEING GOOD.
       *
       * It says there is nothing to be stale, which is not the same as being current: a repository
       * nobody has fetched is one nobody has asked a question about yet, and drawing it as though it
       * were fresh would be the reassuring reading of an empty column.
       *
       * A timestamp in words rather than a relative time, for the reason the other refusals on this
       * screen are refusals: "3 days ago" computed at render is a different number from the one the
       * next reader computes, and a number that moves under somebody reading it is harder to act on
       * than a date they can look up.
       */}
      <span>
        {indexedAt
          ? `read ${new Date(indexedAt).toLocaleString("en-GB", {
              dateStyle: "medium",
              timeStyle: "short",
            })}`
          : "not read yet"}
        {fileCount === null ? "" : ` · ${fileCount.toLocaleString()} files`}
        {truncated ? " · partial list" : ""}
      </span>
      {onRefresh ? (
        <Button
          disabled={refreshing}
          onClick={onRefresh}
          size="sm"
          type="button"
          variant="ghost"
        >
          <IconRefresh />
          {refreshing ? "Reading…" : "Read again"}
        </Button>
      ) : null}
      {error ? (
        <span className="text-destructive" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
