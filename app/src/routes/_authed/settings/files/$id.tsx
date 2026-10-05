import { IconCopy, IconDownload, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { isCopyable, viewerExplains, viewerFor } from "@/lib/file-viewer";
import {
  artifactContentUrl,
  artifactQueryOptions,
  deleteArtifactMutationOptions,
} from "@/lib/remi";

export const Route = createFileRoute("/_authed/settings/files/$id")({
  component: RouteComponent,
});

/**
 * One saved file: the text inside it, and the two ways to take it away.
 *
 * Its own page rather than a dialog, because a report is the thing a person came here to read and
 * a dialog is sized to confirm something. The list already treats these as the only rows that open
 * somewhere, so the row and the page agree about what a file is for.
 */

function RouteComponent() {
  const { id } = useParams({ from: "/_authed/settings/files/$id" });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const artifact = useQuery(artifactQueryOptions(id));
  const remove = useMutation(deleteArtifactMutationOptions(queryClient));
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  const back = {
    label: "Files",
    linkProps: { to: "/settings/files" as const },
  };
  const file = artifact.data?.artifact;
  const content = file?.content ?? "";
  /*
   * WHAT TO SHOW, DECIDED BY THE TYPE THE SERVER SNIFFED.
   *
   * The kind comes from the same `classifyAttachment` the upload route accepted the file with, so
   * this page and the server cannot disagree about what a file is. Everything is still downloadable
   * and nothing is made unreachable by having no viewer — the switch only chooses how a file is
   * DRAWN, and its worst answer is a note and a download button.
   */
  const viewer = viewerFor(file?.mimeType);
  const bytesUrl = file ? artifactContentUrl(file.id) : "";
  const hasText = content.length > 0;
  const canCopy = isCopyable(viewer, content);
  const explains = viewerExplains(viewer);

  const copy = async () => {
    if (!hasText) return;
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      /*
       * Clipboard needs a secure context, and a person on plain http gets a
       * rejection rather than nothing. The text below stays selectable, so this
       * costs the button and not the ability to take the file away.
       */
      setCopied("failed");
      window.setTimeout(() => setCopied("idle"), 3000);
      return;
    }
    setCopied("done");
    window.setTimeout(() => setCopied("idle"), 2000);
  };

  /*
   * THE BYTES, NOT THE EXTRACTED TEXT.
   *
   * The detail query is capped at 100,000 characters because a person reading a note does not need
   * the rest of it, which makes it the wrong source for a download: a 2 MB CSV would arrive as its
   * first 100,000 characters and be saved as though that were the file. The content route streams
   * the whole thing and the browser saves it under the name the model gave it.
   */
  const download = () => {
    if (!file) return;
    const anchor = document.createElement("a");
    anchor.href = bytesUrl;
    anchor.download = file.name;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };

  /*
   * Deleting from here would otherwise leave the page standing on a file that is gone, showing an
   * empty shell with the file's name still in the title. The list is the honest place to be
   * afterwards, and the list is where Delete already lives.
   */
  const deleteAndLeave = () => {
    remove.mutate(id, {
      onSuccess: () => void navigate({ to: "/settings/files" }),
    });
  };

  if (artifact.isPending) {
    return (
      <PageShell backButton={back} title="File">
        {null}
      </PageShell>
    );
  }

  if (artifact.isError || !file) {
    return (
      <PageShell backButton={back} title="File">
        <p className="mt-12 text-destructive text-sm" role="alert">
          This file could not be opened. It may have been deleted.
        </p>
      </PageShell>
    );
  }

  /*
   * THE PLAYERS, WITH NO CAPTION TRACK ON EITHER, WHICH IS THE POINT RATHER THAN AN OMISSION.
   *
   * This is a person playing back a file they stored, not published media: there is no caption file
   * beside it to point a `<track>` at, so one would be a source that 404s and a control that lies
   * about there being words. Transcripts, where a file has one, are offered separately on this page.
   */
  const audioPlayer = (
    // biome-ignore lint/a11y/useMediaCaption: an upload has no caption track to point at.
    <audio className="mt-3 w-full" controls preload="metadata" src={bytesUrl} />
  );
  const videoPlayer = (
    // biome-ignore lint/a11y/useMediaCaption: as the audio above — an upload carries no caption track.
    <video
      className="mt-3 max-h-[70vh] w-full rounded-lg border border-border bg-black"
      controls
      preload="metadata"
      src={bytesUrl}
    />
  );

  return (
    <PageShell
      backButton={back}
      description={`${file.mimeType ?? "file"}${typeof file.size === "number" ? ` · ${(file.size / 1024).toFixed(1)} KB` : ""}`}
      title={file.name}
      width="wide"
    >
      <PageSection
        action={
          <div className="flex items-center gap-2">
            <Button
              disabled={!canCopy}
              onClick={copy}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconCopy data-icon="inline-start" />
              {copied === "done"
                ? "Copied"
                : copied === "failed"
                  ? "Copy failed"
                  : "Copy"}
            </Button>
            <Button
              disabled={!file}
              onClick={download}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconDownload data-icon="inline-start" />
              Download
            </Button>
          </div>
        }
        description={
          canCopy
            ? `${content.length.toLocaleString()} characters of text, shown in full.`
            : explains
              ? undefined
              : "Previewed from the file itself."
        }
        title={viewerExplains(viewer) ? "File" : "Preview"}
      >
        {viewer === "image" ? (
          /*
           * AN IMAGE, AT ITS OWN SIZE AND NO BIGGER.
           *
           * Constrained on both axes: `max-h` so a tall screenshot does not push the delete button
           * off the page, and `max-w` so a 6000px-wide diagram is drawn at a size somebody can read
           * rather than at one they have to zoom out of. The container scrolls if the file is larger
           * than both, which is the honest answer for something whose dimensions are not known here.
           */
          <div className="mt-3 max-h-[70vh] overflow-auto rounded-lg border border-border bg-card p-2">
            <img
              alt={file.name}
              className="mx-auto max-h-[68vh] max-w-full object-contain"
              src={bytesUrl}
            />
          </div>
        ) : viewer === "pdf" ? (
          /*
           * A PDF IN AN OBJECT, NOT AN IFRAME, AND THE REASON IS THE ORIGIN.
           *
           * A PDF viewer is a plugin with a great deal of power, and in an iframe it shares this
           * app's origin — so a hostile document could reach the session cookie this page is
           * authenticated with. `<object type="application/pdf">` puts the plugin in its own
           * context, and the fallback inside it is the download button for a browser with no viewer
           * at all, which is a real answer rather than a blank rectangle.
           */
          <object
            className="mt-3 h-[70vh] w-full rounded-lg border border-border bg-card"
            data={bytesUrl}
            type="application/pdf"
          >
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-muted-foreground text-sm">
                This browser cannot show a PDF in the page.
              </p>
              <Button
                onClick={download}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconDownload data-icon="inline-start" />
                Download instead
              </Button>
            </div>
          </object>
        ) : viewer === "audio" ? (
          audioPlayer
        ) : viewer === "video" ? (
          /*
           * A VIDEO ELEMENT, WHICH IS WHAT MAKES THE SERVER'S RANGE SUPPORT WORTH HAVING.
           *
           * Without a 206 this element cannot seek: it plays from the start every time and a
           * 500 MB file is a file nobody waits for. `preload="metadata"` asks for the length rather
           * than the bytes, so opening the page does not pull the whole file.
           */
          videoPlayer
        ) : viewer === "text" || hasText ? (
          /*
           * `bg-card` and a plain `border`, the same surface the credential panel
           * uses for something you read rather than scan, so a saved report and
           * a token do not look like two different kinds of thing. Scrolls on its
           * own so a long report does not push the delete button off the page.
           */
          <pre className="mt-3 max-h-[70vh] overflow-auto rounded-lg border border-border bg-card p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {content}
          </pre>
        ) : (
          <p className="mt-3 text-muted-foreground text-sm">
            {viewer === "office"
              ? "This is a Word, Excel or PowerPoint file. There is no viewer for those in the browser, so it is offered as a download — and its text is above if any was extracted."
              : "This kind of file has no preview here, so it is offered as a download."}
          </p>
        )}
      </PageSection>

      <PageSection title="Manage">
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={remove.isPending}
            onClick={deleteAndLeave}
            size="sm"
            type="button"
            variant="destructive"
          >
            <IconTrash data-icon="inline-start" />
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
          <Button
            render={<Link {...back.linkProps} />}
            size="sm"
            type="button"
            variant="ghost"
          >
            Back to files
          </Button>
        </div>
      </PageSection>
    </PageShell>
  );
}
