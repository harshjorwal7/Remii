/**
 * The name a command is typed under.
 *
 * Every command the `/` menu can resolve shares one namespace with the transcript's own record of
 * what was invoked, which is a regex over a leading slash followed by a lower-case word. A tool
 * name is camelCase, so kebabbing it is not cosmetic: `showBarChart` typed as-is would carry a
 * capital, match nothing, and the message would go out reading as ordinary prose with no chip beside
 * it.
 *
 * Pure and exported so the picker, the command list and the tests all name a command the same way.
 */
export function commandSlug(name: string): string {
  return (
    name
      // Split on the camel humps first: `showBarChart` becomes `show-Bar-Chart`, not `showbarchart`.
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

/**
 * The short name under which a component is typed, e.g. `showBarChart` → `bar-chart`. This is what
 * the dropdown shows; the full `show-bar-chart` slug remains as a hidden alias so chips inserted
 * before this existed still resolve.
 */
export function commandAlias(name: string): string {
  return commandSlug(name)
    .replace(/^(show|ask|draw)-/, "")
    .replace(/^-+|-+$/g, "");
}

/**
 * Canonical form for name comparison: lowercase, alphanumerics-only. Lets `/barchart`,
 * `/bar-chart` and `/BarChart` all resolve to the same command.
 */
export function normalizeCommandName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
