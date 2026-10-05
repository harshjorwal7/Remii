import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame } from "./frame";

/* -------------------------------------------------------------------------- Rating & Feedback */

export const FeedbackCardProps = z.object({
  title: z.string().describe("Survey or evaluation title"),
  prompt: z.string().describe("What the person is rating, in a sentence"),
  scaleLabelLow: z
    .string()
    .optional()
    .describe("Label for lowest score, e.g. 'Poor'"),
  scaleLabelHigh: z
    .string()
    .optional()
    .describe("Label for highest score, e.g. 'Great'"),
  submitLabel: z
    .string()
    .optional()
    .describe("Button label, e.g. 'Submit rating'"),
});

type FeedbackArgs = z.infer<typeof FeedbackCardProps>;

type Waiting<T> = {
  status?: "inProgress" | "executing" | "complete";
  args?: T;
  respond?: (result: unknown) => Promise<void>;
  result?: string;
};

function parseResult(
  result: string | undefined,
): Record<string, unknown> | undefined {
  if (!result) return undefined;
  try {
    const val = JSON.parse(result);
    return typeof val === "object" && val !== null ? val : undefined;
  } catch {
    return undefined;
  }
}

export function FeedbackCard(props: Waiting<FeedbackArgs>) {
  const { args, status, respond } = props;
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args?.title ?? "Preparing feedback question…"}>
        <p className="text-sm text-muted-foreground">
          Waiting for the assistant…
        </p>
      </GalleryFrame>
    );
  }

  const recorded =
    status === "complete" ? parseResult(props.result) : undefined;
  const isDone = status === "complete" || Boolean(recorded);

  const submit = async () => {
    if (!respond || rating === null || sending) return;
    setSending(true);
    await respond({
      rating,
      comment: comment.trim() || undefined,
    });
  };

  return (
    <GalleryFrame
      action={
        isDone ? (
          <Badge tone="positive">Submitted</Badge>
        ) : (
          <Badge tone="caution">Waiting on you</Badge>
        )
      }
      title={args?.title ?? "Feedback"}
    >
      <p className="text-sm font-medium">{args?.prompt}</p>

      {isDone ? (
        <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
          <p className="font-semibold text-foreground">
            Rating: {String(recorded?.rating ?? rating ?? "Recorded")} / 5
          </p>
          {recorded?.comment || comment ? (
            <p className="mt-1 text-muted-foreground italic">
              &ldquo;{String(recorded?.comment ?? comment)}&rdquo;
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((score) => (
              <button
                type="button"
                className={`flex size-10 items-center justify-center rounded-lg border font-semibold text-sm transition-colors ${
                  rating === score
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-foreground/5 text-foreground"
                }`}
                disabled={sending}
                key={score}
                onClick={() => setRating(score)}
              >
                {score}
              </button>
            ))}
          </div>

          <div className="flex justify-between text-[11px] text-muted-foreground px-1">
            <span>{args?.scaleLabelLow ?? "Needs improvement"}</span>
            <span>{args?.scaleLabelHigh ?? "Exceptional"}</span>
          </div>

          <input
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground"
            disabled={sending}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment or suggestions…"
            value={comment}
          />

          <div className="flex justify-end pt-1">
            <Button
              disabled={rating === null || sending}
              onClick={() => void submit()}
              size="sm"
            >
              {sending ? "Sending…" : (args?.submitLabel ?? "Submit feedback")}
            </Button>
          </div>
        </div>
      )}
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Date Range Selector */

export const DateRangeProps = z.object({
  title: z.string().describe("Selector prompt title"),
  caption: z.string().optional().describe("Context on what this range filters"),
  defaultStartDate: z
    .string()
    .optional()
    .describe("Suggested default start (YYYY-MM-DD)"),
  defaultEndDate: z
    .string()
    .optional()
    .describe("Suggested default end (YYYY-MM-DD)"),
  submitLabel: z.string().optional().describe("Defaults to 'Apply range'"),
});

type DateRangeArgs = z.infer<typeof DateRangeProps>;

export function DateRangeCard(props: Waiting<DateRangeArgs>) {
  const { args, status, respond } = props;
  const [startDate, setStartDate] = useState(
    args?.defaultStartDate ?? "2026-09-01",
  );
  const [endDate, setEndDate] = useState(args?.defaultEndDate ?? "2026-09-22");
  const [preset, setPreset] = useState<string | null>("Custom");
  const [sending, setSending] = useState(false);

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args?.title ?? "Preparing date picker…"}>
        <p className="text-sm text-muted-foreground">
          Waiting for the assistant…
        </p>
      </GalleryFrame>
    );
  }

  const recorded =
    status === "complete" ? parseResult(props.result) : undefined;
  const isDone = status === "complete" || Boolean(recorded);

  const applyPreset = (label: string, start: string, end: string) => {
    setPreset(label);
    setStartDate(start);
    setEndDate(end);
  };

  const submit = async () => {
    if (!respond || sending) return;
    setSending(true);
    await respond({
      preset: preset ?? "Custom",
      startDate,
      endDate,
    });
  };

  return (
    <GalleryFrame
      action={
        isDone ? (
          <Badge tone="positive">Selected</Badge>
        ) : (
          <Badge tone="caution">Waiting on you</Badge>
        )
      }
      caption={args?.caption}
      title={args?.title ?? "Select date range"}
    >
      {isDone ? (
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
          <p className="font-semibold text-foreground">
            Period: {String(recorded?.startDate ?? startDate)} to{" "}
            {String(recorded?.endDate ?? endDate)}
          </p>
          {recorded?.preset ? (
            <p className="mt-0.5 text-muted-foreground">
              Preset: {String(recorded.preset)}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3.5">
          <div className="flex flex-wrap gap-1.5">
            {[
              { label: "Today", start: "2026-09-22", end: "2026-09-22" },
              { label: "Last 7 days", start: "2026-09-15", end: "2026-09-22" },
              { label: "Last 30 days", start: "2026-08-23", end: "2026-09-22" },
              {
                label: "Quarter to Date",
                start: "2026-07-01",
                end: "2026-09-22",
              },
            ].map((p) => (
              <button
                type="button"
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  preset === p.label
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:bg-foreground/5"
                }`}
                disabled={sending}
                key={p.label}
                onClick={() => applyPreset(p.label, p.start, p.end)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="interactive-start-date"
                className="block text-xs font-medium text-muted-foreground mb-1"
              >
                Start date
              </label>
              <input
                id="interactive-start-date"
                type="date"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs text-foreground"
                disabled={sending}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setPreset("Custom");
                }}
                value={startDate}
              />
            </div>
            <div>
              <label
                htmlFor="interactive-end-date"
                className="block text-xs font-medium text-muted-foreground mb-1"
              >
                End date
              </label>
              <input
                id="interactive-end-date"
                type="date"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs text-foreground"
                disabled={sending}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setPreset("Custom");
                }}
                value={endDate}
              />
            </div>
          </div>

          <div className="flex justify-end pt-1">
            <Button disabled={sending} onClick={() => void submit()} size="sm">
              {sending ? "Applying…" : (args?.submitLabel ?? "Apply range")}
            </Button>
          </div>
        </div>
      )}
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Danger Confirmation */

export const ConfirmationProps = z.object({
  title: z.string().describe("Dangerous action title"),
  summary: z
    .string()
    .describe("Explanation of what will be irrevocably modified or deleted"),
  warning: z.string().describe("Consequences and impact warning"),
  confirmKeyword: z
    .string()
    .describe("Exact keyword user must type, e.g. 'DELETE' or resource name"),
  actionLabel: z
    .string()
    .optional()
    .describe("Button label, e.g. 'Permanently delete'"),
});

type ConfirmationArgs = z.infer<typeof ConfirmationProps>;

export function ConfirmationCard(props: Waiting<ConfirmationArgs>) {
  const { args, status, respond } = props;
  const [typed, setTyped] = useState("");
  const [sending, setSending] = useState<"confirmed" | "cancelled" | null>(
    null,
  );

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args?.title ?? "Preparing confirmation…"}>
        <p className="text-sm text-muted-foreground">
          Waiting for the assistant…
        </p>
      </GalleryFrame>
    );
  }

  const recorded =
    status === "complete" ? parseResult(props.result) : undefined;
  const isDone = status === "complete" || Boolean(recorded);
  const keyword = args?.confirmKeyword ?? "CONFIRM";
  const matched = typed.trim() === keyword;

  const answer = async (confirmed: boolean) => {
    if (!respond || sending) return;
    setSending(confirmed ? "confirmed" : "cancelled");
    await respond({
      confirmed,
      keywordEntered: typed.trim(),
    });
  };

  return (
    <GalleryFrame
      action={
        isDone ? (
          <Badge tone={recorded?.confirmed ? "negative" : "neutral"}>
            {recorded?.confirmed ? "Action Executed" : "Cancelled"}
          </Badge>
        ) : (
          <Badge tone="negative">Irreversible</Badge>
        )
      }
      title={args?.title ?? "Confirm sensitive action"}
    >
      <div className="space-y-3">
        <p className="text-sm">{args?.summary}</p>
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
          <p className="font-semibold">⚠️ Warning</p>
          <p className="mt-0.5 leading-relaxed">{args?.warning}</p>
        </div>

        {isDone ? null : (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-muted-foreground">
              To proceed, type{" "}
              <span className="font-mono font-bold text-foreground">
                {keyword}
              </span>{" "}
              below:
            </p>
            <input
              className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground"
              disabled={Boolean(sending)}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`Type "${keyword}" to confirm`}
              value={typed}
            />
            <div className="flex gap-2 justify-end pt-1">
              <Button
                disabled={Boolean(sending)}
                onClick={() => void answer(false)}
                size="sm"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={!matched || Boolean(sending)}
                onClick={() => void answer(true)}
                size="sm"
                variant="destructive"
              >
                {sending === "confirmed"
                  ? "Executing…"
                  : (args?.actionLabel ?? "Confirm & Execute")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Multi-Select Choice */

export const MultiSelectProps = z.object({
  title: z.string().describe("Prompt question or task"),
  summary: z.string().optional().describe("Context or selection guidelines"),
  options: z
    .array(
      z.object({
        id: z.string().describe("Option identifier returned to bot"),
        label: z.string().describe("Option title"),
        description: z.string().optional(),
        defaultChecked: z.boolean().optional(),
      }),
    )
    .min(2)
    .max(12)
    .describe("List of selectable choices"),
  minSelected: z.number().optional().describe("Minimum selections required"),
  maxSelected: z.number().optional().describe("Maximum selections allowed"),
  submitLabel: z
    .string()
    .optional()
    .describe("Defaults to 'Confirm selection'"),
});

type MultiSelectArgs = z.infer<typeof MultiSelectProps>;

export function MultiSelectCard(props: Waiting<MultiSelectArgs>) {
  const { args, status, respond } = props;
  const options = args?.options ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => {
    const init = new Set<string>();
    for (const opt of options) {
      if (opt.defaultChecked) init.add(opt.id);
    }
    return init;
  });
  const [sending, setSending] = useState(false);

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args?.title ?? "Preparing selection…"}>
        <p className="text-sm text-muted-foreground">
          Waiting for the assistant…
        </p>
      </GalleryFrame>
    );
  }

  const recorded =
    status === "complete" ? parseResult(props.result) : undefined;
  const isDone = status === "complete" || Boolean(recorded);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === options.length) setSelected(new Set());
    else setSelected(new Set(options.map((o) => o.id)));
  };

  const min = args?.minSelected ?? 1;
  const max = args?.maxSelected;
  const valid =
    selected.size >= min && (max === undefined || selected.size <= max);

  const submit = async () => {
    if (!respond || !valid || sending) return;
    setSending(true);
    await respond({
      selectedIds: Array.from(selected),
      count: selected.size,
    });
  };

  return (
    <GalleryFrame
      action={
        isDone ? (
          <Badge tone="positive">Selected</Badge>
        ) : (
          <Badge tone="caution">
            {selected.size} of {options.length} picked
          </Badge>
        )
      }
      caption={args?.summary}
      title={args?.title ?? "Choose options"}
    >
      {isDone ? (
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
          <p className="font-semibold text-foreground">
            {Array.isArray(recorded?.selectedIds)
              ? `${(recorded.selectedIds as string[]).length} options selected`
              : `${selected.size} options selected`}
          </p>
          <ul className="mt-1 list-disc pl-4 text-muted-foreground">
            {options
              .filter((o) =>
                Array.isArray(recorded?.selectedIds)
                  ? (recorded.selectedIds as string[]).includes(o.id)
                  : selected.has(o.id),
              )
              .map((o) => (
                <li key={o.id}>{o.label}</li>
              ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-between items-center text-xs pb-1 border-b border-border/60">
            <span className="text-muted-foreground">
              {min > 1
                ? `Select at least ${min} options`
                : "Select all that apply"}
            </span>
            <button
              type="button"
              className="text-primary hover:underline font-medium"
              disabled={sending}
              onClick={toggleAll}
            >
              {selected.size === options.length ? "Deselect all" : "Select all"}
            </button>
          </div>

          <ul className="space-y-1.5 max-h-56 overflow-y-auto">
            {options.map((opt) => {
              const checked = selected.has(opt.id);
              return (
                <li key={opt.id}>
                  <button
                    type="button"
                    className={`flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left text-xs transition-colors ${
                      checked
                        ? "border-primary/50 bg-primary/5"
                        : "border-border hover:bg-foreground/5"
                    }`}
                    disabled={sending}
                    onClick={() => toggle(opt.id)}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border text-[10px] font-bold ${
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border"
                      }`}
                    >
                      {checked ? "✓" : ""}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground">{opt.label}</p>
                      {opt.description ? (
                        <p className="text-muted-foreground text-[11px] mt-0.5">
                          {opt.description}
                        </p>
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="flex justify-end pt-1">
            <Button
              disabled={!valid || sending}
              onClick={() => void submit()}
              size="sm"
            >
              {sending ? "Saving…" : (args?.submitLabel ?? "Confirm selection")}
            </Button>
          </div>
        </div>
      )}
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- GALLERY Export */

export const GALLERY: GalleryComponent[] = [
  {
    name: "askFeedback",
    title: "Rating & feedback",
    kind: "decision",
    description:
      "Ask the user to rate an output or experience on a 1-5 score with optional written feedback, and WAIT for their response.",
    parameters: FeedbackCardProps,
    Component: FeedbackCard as GalleryComponent["Component"],
    preview: {
      status: "executing",
      args: {
        title: "Incident Post-Mortem Quality",
        prompt:
          "How thorough and actionable was this automated root-cause analysis?",
        scaleLabelLow: "Incomplete",
        scaleLabelHigh: "Exceeded expectations",
        submitLabel: "Submit review",
      },
      respond: async () => {},
    },
  },
  {
    name: "askDateRange",
    title: "Date range selector",
    kind: "decision",
    description:
      "Prompt the user to choose a date range using standard presets (Today, 7 days, 30 days) or custom date pickers, and WAIT for their answer.",
    parameters: DateRangeProps,
    Component: DateRangeCard as GalleryComponent["Component"],
    preview: {
      status: "executing",
      args: {
        title: "Export Audit Log Window",
        caption:
          "Select the timeframe to compile security and access records for",
        defaultStartDate: "2026-09-01",
        defaultEndDate: "2026-09-22",
        submitLabel: "Generate export",
      },
      respond: async () => {},
    },
  },
  {
    name: "askConfirmation",
    title: "Danger confirmation",
    kind: "decision",
    description:
      "Require the user to type an explicit confirmation keyword before executing an irreversible or destructive action, and WAIT for their confirmation.",
    parameters: ConfirmationProps,
    Component: ConfirmationCard as GalleryComponent["Component"],
    preview: {
      status: "executing",
      args: {
        title: "Tear Down Test Cluster",
        summary:
          "Destroy 12 worker nodes and persistent volume claims in staging-east-2.",
        warning:
          "All uncommitted test databases and cached volume snapshots will be permanently deleted.",
        confirmKeyword: "TEARDOWN",
        actionLabel: "Destroy staging cluster",
      },
      respond: async () => {},
    },
  },
  {
    name: "askMultiSelect",
    title: "Multi-select choice",
    kind: "decision",
    description:
      "Present a list of multiple choices with checkboxes and WAIT for the user to select one or more options before resuming.",
    parameters: MultiSelectProps,
    Component: MultiSelectCard as GalleryComponent["Component"],
    preview: {
      status: "executing",
      args: {
        title: "Target Deployment Regions",
        summary:
          "Select which AWS edge regions should receive the canary build:",
        options: [
          {
            id: "us-east-1",
            label: "US East (N. Virginia)",
            description: "Primary traffic hub",
            defaultChecked: true,
          },
          {
            id: "eu-central-1",
            label: "Europe (Frankfurt)",
            description: "GDPR compliance cluster",
            defaultChecked: true,
          },
          {
            id: "ap-southeast-1",
            label: "Asia Pacific (Singapore)",
            description: "High latency region",
          },
          {
            id: "sa-east-1",
            label: "South America (São Paulo)",
            description: "Backup edge",
          },
        ],
        submitLabel: "Deploy to selected",
      },
      respond: async () => {},
    },
  },
];
