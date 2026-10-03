import {
  IconChevronRight,
  IconDownload,
  IconFileText,
  IconUpload,
} from "@tabler/icons-react";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useRef, useState } from "react";
import { FILE_PICKER_ACCEPT } from "@/components/channels/composer/attachments";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { downloadTextFile } from "@/lib/download";
import {
  artifactsQueryOptions,
  deleteArtifactMutationOptions,
  fetchArtifactText,
  uploadArtifact,
} from "@/lib/remi";

export const Route = createFileRoute("/_authed/settings/files/")({
  component: RouteComponent,
});

/**
 * Files your Bot saved for you.
 *
 * Notes, lists, documents and data it wrote while working. A row opens the file; deleting one
 * removes it for good.
 */
/**
 * PICK A FILE AND SEND IT.
 *
 * A label wrapping a hidden `<input type="file">`, rather than a button that opens a dialog on
 * click: the native input gets the operating system's own file picker, including "recents" and the
 * places a person actually stores things, and it is keyboard-reachable without a single line of
 * focus management. What is added on top is the part the native control does not give — a name, a
 * progress figure for a large file, and the server's own sentence when it refuses.
 */
function UploadControl({ queryClient }: { queryClient: QueryClient }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "busy"; name: string; fraction: number }
    | { kind: "done" }
    | { kind: "failed"; reason: string }
  >({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);

  const send = async (file: File) => {
    setState({ kind: "busy", name: file.name, fraction: 0 });
    try {
      await uploadArtifact(file, (fraction) =>
        setState({ kind: "busy", name: file.name, fraction }),
      );
      setState({ kind: "done" });
      // The list has to be refetched or the new file does not appear until a reload, which reads
      // as the upload having silently failed.
      void queryClient.invalidateQueries({ queryKey: ["remi", "artifacts"] });
      window.setTimeout(() => setState({ kind: "idle" }), 2500);
    } catch (error) {
      // The server's sentence, not a generic one — see `uploadArtifact`.
      setState({
        kind: "failed",
        reason:
          error instanceof Error
            ? error.message
            : "That file could not be saved.",
      });
    }
  };

  return (
    <div className="flex items-center gap-2">
      {state.kind === "busy" ? (
        <span className="text-muted-foreground text-xs" role="status">
          Uploading {state.name} — {Math.round(state.fraction * 100)}%
        </span>
      ) : state.kind === "done" ? (
        <span className="text-xs" role="status">
          Uploaded
        </span>
      ) : state.kind === "failed" ? (
        <span className="text-destructive text-xs" role="alert">
          {state.reason}
        </span>
      ) : null}
      <label
        className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 text-sm transition-colors hover:bg-foreground/5 focus-within:outline-hidden focus-within:ring-1 focus-within:ring-ring"
        /*
         * A LABEL, NOT A BUTTON, and the input is inside it so a click anywhere on the label opens
         * the dialog and the keyboard reaches the input in the usual order. The `sr-only` class keeps
         * the native control focusable and reachable while showing one button rather than two.
         */
      >
        {/* Tabler icons carry a 24px default and nothing here constrains them, so this is sized
            explicitly to match the label's `text-sm` instead of standing a head taller than it. */}
        <IconUpload className="size-4" />
        Upload
        <input
          ref={input}
          accept={FILE_PICKER_ACCEPT}
          className="sr-only"
          disabled={state.kind === "busy"}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the SAME file twice in a row fires `change` again — a picker that
            // silently does nothing on the second try is indistinguishable from a broken button.
            event.target.value = "";
            if (file) void send(file);
          }}
          type="file"
        />
      </label>
    </div>
  );
}

function RouteComponent() {
  const queryClient = useQueryClient();
  const files = useQuery(artifactsQueryOptions());
  const remove = useMutation(deleteArtifactMutationOptions(queryClient));

  return (
    <PageShell
      action={<UploadControl queryClient={queryClient} />}
      description="Files your Bot saved while working, and files you upload here: notes, lists, documents and data."
      title="Files"
    >
      {files.isPending ? null : files.isError ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Files could not be loaded. Reload the page.
        </p>
      ) : (
        <PageSection>
          {(files.data?.artifacts ?? []).length === 0 ? (
            <PageEmpty>
              No files yet. Ask your Bot to save something, or upload a file
              from your own computer with the button above.
            </PageEmpty>
          ) : (
            <PageRows>
              {(files.data?.artifacts ?? []).map((file, index, all) => (
                <React.Fragment key={file.id}>
                  {/*
                   * The row itself is the link, the way every other list on these settings pages
                   * opens its detail. A file whose name is not a link is a dead end: the page said
                   * "Reading one opens the saved text" and offered nothing to read with.
                   */}
                  <Item
                    data-testid={`file-${file.id}`}
                    render={
                      <Link params={{ id: file.id }} to="/settings/files/$id" />
                    }
                    size="sm"
                  >
                    <RowMark>
                      <IconFileText className="size-4 text-muted-foreground" />
                    </RowMark>
                    <ItemContent>
                      <ItemTitle className="font-normal">{file.name}</ItemTitle>
                      <ItemDescription>
                        {file.mimeType ?? "file"}
                        {typeof file.size === "number"
                          ? ` · ${(file.size / 1024).toFixed(1)} KB`
                          : ""}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Delete is a button on a link row, so it stops the row's own navigation
                       * rather than opening the file on the way to deleting it.
                       */}
                      {/*
                       * On the row as well as on the file's own page, because the
                       * two are not the same wish. Somebody scanning a list wants
                       * the report and nothing else, and making them open a file
                       * to discover what it is before taking it is a step for no
                       * reason. Stops the row's navigation the same way Delete
                       * does.
                       */}
                      <Button
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          /*
                           * The text is fetched here rather than held on the
                           * row: the list endpoint deliberately omits it, so
                           * this is a second read paid for only by somebody who
                           * actually asked for the file. A rejection is
                           * swallowed because there is nowhere on a list row to
                           * report it, and the failure is a download that does
                           * not start — which is what the person sees anyway.
                           */
                          void fetchArtifactText(file.id)
                            .then((detail) => downloadTextFile(detail))
                            .catch(() => undefined);
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <IconDownload />
                        Download
                      </Button>
                      <Button
                        disabled={remove.isPending}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          remove.mutate(file.id);
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                      <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </ItemActions>
                  </Item>
                  {index !== all.length - 1 && <Separator />}
                </React.Fragment>
              ))}
            </PageRows>
          )}
        </PageSection>
      )}
    </PageShell>
  );
}
