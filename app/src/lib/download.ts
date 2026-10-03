/**
 * Saving a Bot's saved text to disk.
 *
 * Its own module because two places need it — the list row and the file's own
 * page — and a download that works in one and not the other is worse than one
 * that fails in both.
 */

/** What a browser should save the file as. */
export function downloadFileName(file: {
  name: string;
  mimeType?: string | null;
}): string {
  /*
   * A name with no extension is what a Bot that invented a title tends to
   * produce, and a browser given `report` writes a file the system cannot open.
   * The extension is taken from the text's own type when the name does not
   * carry one, so what lands on disk is something the person can double-click.
   */
  const name = file.name.trim() || "file";
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return name;
  const mime = file.mimeType ?? "";
  const extension = /\.md$/i.test(name)
    ? "md"
    : mime === "text/markdown"
      ? "md"
      : mime === "application/json"
        ? "json"
        : mime === "text/csv"
          ? "csv"
          : mime === "text/html"
            ? "html"
            : "txt";
  return `${name}.${extension}`;
}

/**
 * Hand the browser a blob and let it write the file.
 *
 * The object URL is released on a later tick, and the anchor is in the document
 * when it is clicked. Revoking synchronously after `click()` looks harmless and
 * is not: the download is read from the blob after the click has been
 * dispatched, so freeing it in the same tick cancels a download that has already
 * started — which presents as a button that does nothing. An anchor that was
 * never appended is ignored outright by some browsers for the same reason.
 */
export function downloadTextFile(file: {
  name: string;
  mimeType?: string | null;
  content: string;
}): void {
  if (!file.content) return;
  const url = URL.createObjectURL(
    new Blob([file.content], { type: file.mimeType ?? "text/plain" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = downloadFileName(file);
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
