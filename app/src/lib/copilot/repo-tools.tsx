import { useFrontendTool } from "@copilotkit/react-core/v2";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";

/**
 * Reading the repository a skill points at, from inside a conversation.
 *
 * A skill may name a public GitHub repository, and a Bot holding that skill is offered three tools to
 * read it: what the repository is and what files it holds, a search across the file list and the
 * documentation, and one file at a time. This is what lets somebody write a skill that says "answer
 * from how this project actually does it" without describing the project in the skill.
 *
 * WHY THESE ARE NOT CONNECTOR TOOLS. A skill's whole reason for being writable by anybody signed in is
 * that it adds no capability — it can only ask a Bot for what that Bot was already granted. An MCP
 * server breaks that: it stores a credential and opens a path into another company's system. A public
 * repository does not, which is why this lives beside the instruction rather than in the plugin grant
 * table, and why `skills.yaml` documents these as the app's own rather than `serverId/toolName` refs.
 * See `server/src/db/schema/plugins.ts` on `skillRepos` and `plugins/repo-index.ts` for the argument.
 *
 * WHY THEY ARE GATED ON THE GRANT, and it is the same gate that stops a URL being enough. Three more
 * tools on every run is not free — a model picks reliably out of about ten, which is the entire reason
 * per-run narrowing exists — so a Bot with no repository-bearing skill is offered none of them at all.
 * What the model can then reach is the set of repositories its granted skills name, and no others: the
 * `repo` argument below is an enum drawn from that set, and every call is checked against the same
 * grant again on the server. Naming a repository the Bot does not hold is not a wider reach, it is a
 * 404.
 *
 * WHY THEY ARE IN THE BROWSER. The same reason `skill-tools.tsx` gives. A repository belongs to a
 * skill, a skill is invoked by the composer, and the browser is the only place that knows which skill
 * is in play for this run. The server preserves the system row the skill came in as
 * (`remi/loop-agent.ts`), so the instruction and the tools arrive together.
 */

type Bound = {
  /** The skill's slug, which is what the server gates the read on. */
  slug: string;
  /** `owner/repo`, plus branch and folder when there are any — for the model to read. */
  label: string;
  /** What the model calls it. A slug, because it is short, unique and already in its vocabulary. */
  key: string;
};

export function RepoTools() {
  // Same guard as `SkillTools`: grants are only fetched once a surface has declared its Bot, and the
  // placeholder is not one the server knows, so asking would 404 on every poll.
  const declared = useDeclaredBotId();
  const { data: granted } = useQuery(agentPluginsQueryOptions(declared ?? ""));

  /*
   * WHICH REPOSITORIES, resolved from the granted skills rather than from a field on the run.
   *
   * Two skills may point at the same repository, and then there is one repository and two skills that
   * asked for it — so this dedupes on the address and keeps the first slug, because a repository with
   * two grants is one thing to read and naming it twice would invite the model to wonder which of the
   * two skills it was reading under. The kept slug is the one the server is asked about, and it passed
   * the same grant check the other did.
   */
  const bound = useMemo<Bound[]>(() => {
    const seen = new Map<string, Bound>();
    for (const skill of granted?.skills ?? []) {
      const repo = skill.repo;
      if (!repo) continue;
      const address = repo.url;
      if (seen.has(address)) continue;
      seen.set(address, {
        slug: skill.slug,
        key: skill.slug,
        label: `${address.replace(/^https:\/\/github\.com\//, "")}`,
      });
    }
    return [...seen.values()];
  }, [granted?.skills]);

  const available = bound.length > 0;

  /*
   * THE ENUM, AS A STRING RATHER THAN A UNION OF LITERALS.
   *
   * Zod's `z.enum` needs its members at build time and this list is decided per Bot by which skills it
   * was granted, so an enum of slugs cannot be written. What it could be is a `z.literal` union built
   * from the same array, and that is not worth the cost of every re-render producing a new schema for
   * CopilotKit to diff. A plain string validated in the handler is the same gate one step later, and
   * the handler's refusal is a sentence a model can act on rather than a validation error it can only
   * retry.
   */
  const repoArgument = (whatItIsFor: string) =>
    z.object({
      repo: z
        .string()
        .optional()
        .describe(
          bound.length === 1
            ? `The repository to ${whatItIsFor}. Omit it — there is only one.`
            : `Which repository to ${whatItIsFor}: ${bound.map((entry) => entry.key).join(", ")}. Omit it if there is only one.`,
        ),
    });

  /**
   * Resolve the model's `repo` to a skill the Bot actually holds.
   *
   * The answer is a sentence rather than an exception, and it names what IS available — a model that
   * guessed a slug and was told only "no" will guess again, whereas one told which repositories it has
   * will use one.
   */
  const resolve = (asked: unknown): Bound | string => {
    if (bound.length === 1 && (asked === undefined || asked === "")) {
      return bound[0] as Bound;
    }
    const wanted = typeof asked === "string" ? asked.trim() : "";
    if (wanted === "" && bound.length > 0) {
      // No term, several repositories: say so rather than silently picking the first, because reading
      // the wrong codebase is an answer the model would then report as fact.
      return bound.length === 1
        ? (bound[0] as Bound)
        : `Which repository? ${bound.map((entry) => entry.label).join(", ")}.`;
    }
    const found = bound.find((entry) => entry.key === wanted);
    if (found) return found;
    return `There is no repository called ${wanted} on this Bot. It has ${bound.map((entry) => entry.label).join(", ")}.`;
  };

  useFrontendTool({
    name: "repo_overview",
    description: `What a repository is and which files it holds: its description, its language, the full list of file paths, and which of those files were read in full (the README, docs and manifests). Start here — the file paths come from a cached reading and everything else is a guess until you look. Repositories: ${bound.map((entry) => entry.label).join(", ") || "none"}.`,
    parameters: repoArgument("describe"),
    available,
    handler: async ({ repo }) => {
      const target = resolve(repo);
      if (typeof target === "string") return target;
      return readFrom(
        `/api/plugins/repos/${target.slug}?agentId=${encodeURIComponent(
          declared ?? "",
        )}`,
      );
    },
  });

  useFrontendTool({
    name: "repo_search",
    description: `Find something in a repository by name. Searches the cached list of file paths and the text of the files that were read in full — the README, docs and manifests — and NOT the contents of source files. So an empty result means "not in the file names or the documentation", not "not in the codebase": use repo_overview to find a path and repo_read_file to read it. Matching is case-insensitive and needs no pattern syntax.`,
    parameters: repoArgument("search").extend({
      query: z
        .string()
        .describe("What to look for — a word, a file name, a route, an error."),
    }),
    available,
    handler: async ({ repo, query }) => {
      const target = resolve(repo);
      if (typeof target === "string") return target;
      return readFrom(
        `/api/plugins/repos/${target.slug}?agentId=${encodeURIComponent(
          declared ?? "",
        )}&q=${encodeURIComponent(String(query ?? ""))}`,
      );
    },
  });

  useFrontendTool({
    name: "repo_read_file",
    description: `Read one file from a repository, by the exact path repo_overview or repo_search printed. Long files are cut at ${2000} lines and the reply says so — read the rest with startLine and endLine rather than assuming you have the whole file.`,
    parameters: repoArgument("read").extend({
      path: z
        .string()
        .describe(
          "The file's path, copied exactly from repo_overview or repo_search.",
        ),
      startLine: z
        .number()
        .optional()
        .describe(
          "First line to return, 1-based. For the rest of a file that was cut.",
        ),
      endLine: z
        .number()
        .optional()
        .describe(
          "Last line to return, inclusive. For the rest of a file that was cut.",
        ),
    }),
    available,
    handler: async ({ repo, path, startLine, endLine }) => {
      const target = resolve(repo);
      if (typeof target === "string") return target;
      const params = new URLSearchParams({
        agentId: declared ?? "",
        path: String(path ?? ""),
      });
      if (typeof startLine === "number")
        params.set("startLine", String(startLine));
      if (typeof endLine === "number") params.set("endLine", String(endLine));
      return readFrom(
        `/api/plugins/repos/${target.slug}/file?${params.toString()}`,
      );
    },
  });

  return null;
}

/**
 * One request, as the signed-in person, and never anything else.
 *
 * The response is passed through as text rather than parsed: a repository overview is a file list and a
 * file read is source code, and neither has a shape worth modelling in the browser. The server's own
 * refusals arrive as `{ error }` and are answered with the sentence in it, which is the one written for
 * a reader — for the tool that means "there is no file at that path, here are the paths there are"
 * rather than a 400.
 */
async function readFrom(path: string): Promise<string> {
  const response = await fetch(path, { credentials: "include" });
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON, which for this API means a proxy answered instead of it.
    return "That could not be read from here.";
  }
  if (!response.ok) {
    const error = (parsed as { error?: string } | null)?.error;
    return error ?? "That could not be read from here.";
  }
  return body;
}
