import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame, type Tone } from "./frame";

/* -------------------------------------------------------------------------- Service Status */

const serviceStatusEnum = z
  .enum(["operational", "degraded", "outage", "maintenance"])
  .describe("System operational state");

export const StatusSummaryProps = z.object({
  title: z.string().describe("Name of the system or infrastructure group"),
  overallStatus: serviceStatusEnum.describe("Overall health status"),
  message: z
    .string()
    .optional()
    .describe("Summary message or incident explanation"),
  uptime: z.string().optional().describe("Uptime percentage, e.g. '99.98%'"),
  responseTime: z
    .string()
    .optional()
    .describe("Average response time, e.g. '42ms'"),
  services: z
    .array(
      z.object({
        name: z.string().describe("Service or subcomponent name"),
        status: serviceStatusEnum,
        latency: z.string().optional().describe("Latency, e.g. '35ms'"),
        note: z.string().optional().describe("Short status note if applicable"),
      }),
    )
    .describe("List of sub-services and dependencies"),
});

const STATUS_TONES: Record<z.infer<typeof serviceStatusEnum>, Tone> = {
  operational: "positive",
  degraded: "caution",
  outage: "negative",
  maintenance: "neutral",
};

const STATUS_LABELS: Record<z.infer<typeof serviceStatusEnum>, string> = {
  operational: "All systems normal",
  degraded: "Degraded performance",
  outage: "Major outage",
  maintenance: "Under maintenance",
};

export function StatusSummaryCard(
  props: Partial<z.infer<typeof StatusSummaryProps>>,
) {
  const {
    title,
    overallStatus = "operational",
    message,
    uptime,
    responseTime,
    services = [],
  } = props;
  const tone = STATUS_TONES[overallStatus];

  return (
    <GalleryFrame
      action={<Badge tone={tone}>{STATUS_LABELS[overallStatus]}</Badge>}
      caption={message}
      title={title ?? "System status"}
    >
      {(uptime || responseTime) && (
        <div className="mb-3 flex items-center gap-6 border-b border-border pb-3 text-xs">
          {uptime ? (
            <div>
              <span className="text-muted-foreground">Uptime (30d): </span>
              <span className="font-semibold tabular-nums">{uptime}</span>
            </div>
          ) : null}
          {responseTime ? (
            <div>
              <span className="text-muted-foreground">Avg latency: </span>
              <span className="font-semibold tabular-nums">{responseTime}</span>
            </div>
          ) : null}
        </div>
      )}
      <ul className="divide-y divide-border/60">
        {services.map((svc) => {
          const svcTone = STATUS_TONES[svc.status];
          return (
            <li
              className="flex items-center justify-between py-2 text-sm"
              key={svc.name}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${
                    svc.status === "operational"
                      ? "bg-emerald-500"
                      : svc.status === "degraded"
                        ? "bg-amber-500"
                        : svc.status === "outage"
                          ? "bg-red-500"
                          : "bg-muted-foreground"
                  }`}
                />
                <span className="truncate font-medium">{svc.name}</span>
                {svc.note ? (
                  <span className="truncate text-xs text-muted-foreground">
                    ({svc.note})
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {svc.latency ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {svc.latency}
                  </span>
                ) : null}
                <Badge tone={svcTone}>{svc.status}</Badge>
              </div>
            </li>
          );
        })}
      </ul>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Timeline */

const timelineTone = z
  .enum(["neutral", "positive", "caution", "negative"])
  .optional();

export const TimelineProps = z.object({
  title: z.string().describe("Title for this event sequence"),
  caption: z.string().optional().describe("Subtitle or brief explanation"),
  events: z
    .array(
      z.object({
        time: z
          .string()
          .describe("Timestamp or relative time, e.g. '14:22 UTC'"),
        title: z.string().describe("What happened"),
        description: z.string().optional().describe("Detailed context or logs"),
        tone: timelineTone,
        tag: z
          .string()
          .optional()
          .describe("Short category badge, e.g. 'Deploy'"),
      }),
    )
    .min(1)
    .describe("Chronological series of events"),
});

export function TimelineCard(props: Partial<z.infer<typeof TimelineProps>>) {
  const { title, caption, events = [] } = props;

  return (
    <GalleryFrame caption={caption} title={title ?? "Event timeline"}>
      <ol className="relative ml-2 space-y-4 border-l border-border pl-4">
        {events.map((evt) => (
          // A time and a title are what an entry is; two entries at the same minute with the same
          // heading are the same entry as far as this list can tell, and were before the index was
          // dropped out of the key to keep a reorder from remounting every row.
          <li className="relative" key={`${evt.time}:${evt.title}`}>
            <span
              aria-hidden="true"
              className={`absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-card ${
                evt.tone === "positive"
                  ? "bg-emerald-500"
                  : evt.tone === "negative"
                    ? "bg-red-500"
                    : evt.tone === "caution"
                      ? "bg-amber-500"
                      : "bg-muted-foreground"
              }`}
            />
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                {evt.time}
              </span>
              {evt.tag ? (
                <Badge tone={evt.tone as Tone}>{evt.tag}</Badge>
              ) : null}
            </div>
            <p className="mt-0.5 text-sm font-medium">{evt.title}</p>
            {evt.description ? (
              <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
                {evt.description}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Workflow Steps */

export const StepsProps = z.object({
  title: z.string().describe("Process or workflow name"),
  caption: z.string().optional().describe("Goal or current state overview"),
  steps: z
    .array(
      z.object({
        number: z.number().describe("Step index (1-based)"),
        title: z.string().describe("Step title"),
        description: z
          .string()
          .optional()
          .describe("Details of what this step involves"),
        status: z
          .enum(["completed", "current", "upcoming"])
          .describe("State of this step"),
        note: z.string().optional().describe("Short aside or blocker info"),
      }),
    )
    .describe("Ordered list of execution steps"),
});

export function StepsCard(props: Partial<z.infer<typeof StepsProps>>) {
  const { title, caption, steps = [] } = props;
  const completed = steps.filter((s) => s.status === "completed").length;

  return (
    <GalleryFrame
      action={
        <Badge
          tone={
            completed === steps.length && steps.length > 0
              ? "positive"
              : "neutral"
          }
        >
          Step {completed + (completed < steps.length ? 1 : 0)} of{" "}
          {steps.length}
        </Badge>
      }
      caption={caption}
      title={title ?? "Workflow progression"}
    >
      <div className="space-y-3">
        {steps.map((step) => {
          const isDone = step.status === "completed";
          const isCurrent = step.status === "current";
          return (
            <div
              className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
                isCurrent
                  ? "border-primary/40 bg-foreground/5 shadow-xs"
                  : isDone
                    ? "border-border/60 bg-muted/20 opacity-80"
                    : "border-border bg-card"
              }`}
              key={step.number}
            >
              <span
                aria-hidden="true"
                className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  isDone
                    ? "bg-emerald-500 text-white"
                    : isCurrent
                      ? "bg-primary text-primary-foreground"
                      : "border border-border text-muted-foreground"
                }`}
              >
                {isDone ? "✓" : step.number}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p
                    className={`text-sm font-medium ${isDone ? "line-through text-muted-foreground" : ""}`}
                  >
                    {step.title}
                  </p>
                  {isCurrent ? <Badge tone="caution">In progress</Badge> : null}
                </div>
                {step.description ? (
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {step.description}
                  </p>
                ) : null}
                {step.note ? (
                  <p className="mt-1 text-xs italic text-muted-foreground">
                    Note: {step.note}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Code Diff */

export const CodeDiffProps = z.object({
  filePath: z.string().describe("Relative path or file name changed"),
  description: z.string().optional().describe("Why this diff was applied"),
  additions: z.number().optional().describe("Count of added lines"),
  deletions: z.number().optional().describe("Count of deleted lines"),
  lines: z
    .array(
      z.object({
        type: z
          .enum(["add", "remove", "context"])
          .describe("Line modification type"),
        oldLineNumber: z.number().optional(),
        newLineNumber: z.number().optional(),
        content: z.string().describe("Source code text"),
      }),
    )
    .describe("Unified diff lines"),
});

export function CodeDiffCard(props: Partial<z.infer<typeof CodeDiffProps>>) {
  const {
    filePath = "diff.patch",
    description,
    additions = 0,
    deletions = 0,
    lines = [],
  } = props;

  return (
    <GalleryFrame
      action={
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <span className="text-emerald-600 dark:text-emerald-400">
            +{additions}
          </span>
          <span className="text-red-600 dark:text-red-400">-{deletions}</span>
        </div>
      }
      caption={description}
      title={filePath}
    >
      <div className="overflow-x-auto rounded-md border border-border bg-muted/40 font-mono text-xs">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((l) => {
              const isAdd = l.type === "add";
              const isRemove = l.type === "remove";
              return (
                <tr
                  className={`${
                    isAdd
                      ? "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
                      : isRemove
                        ? "bg-red-500/10 text-red-900 dark:text-red-200"
                        : "text-foreground/80"
                  }`}
                  key={`${l.type}:${l.oldLineNumber ?? ""}:${l.newLineNumber ?? ""}:${l.content}`}
                >
                  <td className="w-8 select-none border-r border-border/50 px-2 py-0.5 text-right text-[11px] text-muted-foreground/60 tabular-nums">
                    {l.oldLineNumber ?? ""}
                  </td>
                  <td className="w-8 select-none border-r border-border/50 px-2 py-0.5 text-right text-[11px] text-muted-foreground/60 tabular-nums">
                    {l.newLineNumber ?? ""}
                  </td>
                  <td className="w-4 select-none px-1 text-center font-bold">
                    {isAdd ? "+" : isRemove ? "-" : " "}
                  </td>
                  <td className="whitespace-pre px-2 py-0.5 font-mono">
                    {l.content}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Log Output */

export const LogStreamProps = z.object({
  title: z.string().describe("Log stream title or service name"),
  caption: z.string().optional().describe("Timeframe or container pod ID"),
  lines: z
    .array(
      z.object({
        timestamp: z.string().optional().describe("Log line timestamp"),
        level: z
          .enum(["info", "warn", "error", "debug"])
          .describe("Log severity"),
        message: z.string().describe("Log text"),
      }),
    )
    .describe("Log lines to inspect"),
});

export function LogStreamCard(props: Partial<z.infer<typeof LogStreamProps>>) {
  const { title, caption, lines = [] } = props;
  const errorCount = lines.filter((l) => l.level === "error").length;
  const warnCount = lines.filter((l) => l.level === "warn").length;

  return (
    <GalleryFrame
      action={
        errorCount > 0 ? (
          <Badge tone="negative">
            {errorCount} {errorCount === 1 ? "error" : "errors"}
          </Badge>
        ) : warnCount > 0 ? (
          <Badge tone="caution">{warnCount} warnings</Badge>
        ) : (
          <Badge tone="positive">Clean</Badge>
        )
      }
      caption={caption}
      title={title ?? "Logs"}
    >
      <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-neutral-950 p-3 font-mono text-xs text-neutral-100 dark:bg-neutral-900">
        {lines.length === 0 ? (
          <p className="text-neutral-500">No logs captured.</p>
        ) : (
          lines.map((entry) => (
            <div
              className="flex items-start gap-2 py-0.5 leading-relaxed"
              key={`${entry.timestamp ?? ""}:${entry.level}:${entry.message}`}
            >
              {entry.timestamp ? (
                <span className="shrink-0 text-neutral-500 tabular-nums select-none">
                  {entry.timestamp}
                </span>
              ) : null}
              <span
                className={`shrink-0 rounded px-1 text-[10px] uppercase font-bold select-none ${
                  entry.level === "error"
                    ? "bg-red-500/20 text-red-400"
                    : entry.level === "warn"
                      ? "bg-amber-500/20 text-amber-300"
                      : entry.level === "debug"
                        ? "bg-neutral-800 text-neutral-400"
                        : "bg-blue-500/20 text-blue-400"
                }`}
              >
                {entry.level}
              </span>
              <span className="min-w-0 break-all">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- GALLERY Export */

export const GALLERY: GalleryComponent[] = [
  {
    name: "showStatusSummary",
    title: "Service status",
    kind: "card",
    description:
      "Show system operational status, latency, uptime, and health breakdown across dependencies. Use during incidents or health checks instead of text descriptions.",
    parameters: StatusSummaryProps,
    Component: StatusSummaryCard as GalleryComponent["Component"],
    preview: {
      title: "Core Platform Status",
      overallStatus: "degraded",
      message:
        "API latency elevated in us-east-1 region. Mitigations underway.",
      uptime: "99.94%",
      responseTime: "142ms",
      services: [
        { name: "Public Gateway", status: "operational", latency: "24ms" },
        { name: "Auth Service", status: "operational", latency: "38ms" },
        {
          name: "Payment Processor",
          status: "degraded",
          latency: "320ms",
          note: "Queue backlog",
        },
        { name: "Database Primary", status: "operational", latency: "12ms" },
      ],
    },
    confirmation:
      "The system status breakdown is now on screen for the person.",
  },
  {
    name: "showTimeline",
    title: "Timeline",
    kind: "card",
    description:
      "Show a chronological sequence of events, incident post-mortems, order updates, or deployment logs with timestamps and tone badges.",
    parameters: TimelineProps,
    Component: TimelineCard as GalleryComponent["Component"],
    preview: {
      title: "Incident INC-842 Timeline",
      caption: "Root cause: transient memory spike on worker nodes",
      events: [
        {
          time: "14:10 UTC",
          title: "Automated alert fired",
          description: "p99 latency crossed 800ms threshold",
          tone: "negative",
          tag: "Alert",
        },
        {
          time: "14:18 UTC",
          title: "On-call engineer paged",
          description: "Diagnostics confirmed pod restarts",
          tone: "caution",
          tag: "Triage",
        },
        {
          time: "14:32 UTC",
          title: "Scaled replica pool",
          description: "Traffic redirected to standby clusters",
          tone: "positive",
          tag: "Fix",
        },
        {
          time: "14:45 UTC",
          title: "Normal operations resumed",
          description: "All telemetry within healthy bounds",
          tone: "positive",
          tag: "Resolved",
        },
      ],
    },
    confirmation: "The event timeline is now on screen for the person.",
  },
  {
    name: "showSteps",
    title: "Workflow steps",
    kind: "card",
    description:
      "Show an ordered sequence of workflow steps or migration phases, indicating which are completed, in progress, and upcoming.",
    parameters: StepsProps,
    Component: StepsCard as GalleryComponent["Component"],
    preview: {
      title: "Production Migration Checklist",
      caption: "Upgrading PostgreSQL cluster to version 17",
      steps: [
        {
          number: 1,
          title: "Snapshot backup",
          description: "Full logical & volume snapshot verified",
          status: "completed",
        },
        {
          number: 2,
          title: "Schema migration",
          description: "Execute zero-downtime DDL statements",
          status: "completed",
        },
        {
          number: 3,
          title: "Switch connection pool",
          description: "Repoint PgBouncer to upgraded target",
          status: "current",
          note: "Waiting for drain",
        },
        {
          number: 4,
          title: "Integrity health checks",
          description: "Run automated sanity test suite",
          status: "upcoming",
        },
      ],
    },
    confirmation: "The workflow steps are now on screen for the person.",
  },
  {
    name: "showCodeDiff",
    title: "Code diff",
    kind: "card",
    description:
      "Show code, config, or migration changes in a unified diff format with line numbers, additions, and deletions.",
    parameters: CodeDiffProps,
    Component: CodeDiffCard as GalleryComponent["Component"],
    preview: {
      filePath: "src/auth/jwt-verifier.ts",
      description: "Fix token expiration grace period calculation",
      additions: 3,
      deletions: 1,
      lines: [
        {
          type: "context",
          oldLineNumber: 42,
          newLineNumber: 42,
          content: "  const now = Math.floor(Date.now() / 1000);",
        },
        {
          type: "remove",
          oldLineNumber: 43,
          newLineNumber: undefined,
          content: "  if (payload.exp < now) {",
        },
        {
          type: "add",
          oldLineNumber: undefined,
          newLineNumber: 43,
          content: "  const graceSeconds = 30;",
        },
        {
          type: "add",
          oldLineNumber: undefined,
          newLineNumber: 44,
          content: "  if (payload.exp + graceSeconds < now) {",
        },
        {
          type: "context",
          oldLineNumber: 44,
          newLineNumber: 45,
          content: "    throw new TokenExpiredError();",
        },
      ],
    },
    confirmation: "The code diff is now on screen for the person.",
  },
  {
    name: "showLogStream",
    title: "Log output",
    kind: "card",
    description:
      "Display container, build, or server logs in a clean console format with severity levels and error indicators.",
    parameters: LogStreamProps,
    Component: LogStreamCard as GalleryComponent["Component"],
    preview: {
      title: "Build logs",
      caption: "workflow-run #4812 (main branch)",
      lines: [
        {
          timestamp: "10:14:02",
          level: "info",
          message: "Starting container runtime bun:1.2-alpine",
        },
        {
          timestamp: "10:14:05",
          level: "debug",
          message: "Restoring node_modules cache key 9a2f1b",
        },
        {
          timestamp: "10:14:12",
          level: "warn",
          message: "Deprecated package '@types/node@18' detected",
        },
        {
          timestamp: "10:14:20",
          level: "info",
          message: "Compiled 142 modules in 480ms",
        },
        {
          timestamp: "10:14:22",
          level: "info",
          message: "Test suite finished: 86 passed, 0 failed",
        },
      ],
    },
    confirmation: "The log stream is now on screen for the person.",
  },
];
