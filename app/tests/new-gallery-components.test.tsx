import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  GALLERY as BUSINESS_GALLERY,
  ComparisonCard,
  ComparisonProps,
  CostBreakdownCard,
  CostBreakdownProps,
  KpiGridCard,
  KpiGridProps,
} from "@/components/gallery/business";
import {
  ConfirmationCard,
  ConfirmationProps,
  DateRangeCard,
  DateRangeProps,
  FeedbackCard,
  FeedbackCardProps,
  GALLERY as INTERACTIVE_GALLERY,
  MultiSelectCard,
  MultiSelectProps,
} from "@/components/gallery/interactive";
import {
  CodeDiffCard,
  CodeDiffProps,
  LogStreamCard,
  LogStreamProps,
  StatusSummaryCard,
  StatusSummaryProps,
  StepsCard,
  StepsProps,
  GALLERY as SYSTEM_GALLERY,
  TimelineCard,
  TimelineProps,
} from "@/components/gallery/system";
import {
  FaqCard,
  FaqProps,
  KanbanCard,
  KanbanProps,
  PersonProfileCard,
  PersonProfileProps,
  ScheduleCard,
  ScheduleProps,
  GALLERY as TEAM_GALLERY,
} from "@/components/gallery/team";
import {
  FunnelCard,
  FunnelProps,
  GaugeCard,
  GaugeProps,
  HeatmapCard,
  HeatmapProps,
  ScatterPlotCard,
  ScatterPlotProps,
  GALLERY as VISUALS_GALLERY,
} from "@/components/gallery/visuals";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup({ document });
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/**
 * A preview, parsed against the schema that describes it.
 *
 * Every one of these call sites asserted `safeParse(preview).success` and then immediately spread
 * `preview as any` into the component — so the assertion proved the preview was well-shaped and the
 * next line threw that knowledge away, which is also the only reason the casts typechecked. If the
 * schema and the component's own props ever drifted apart, the assertion would still pass and the
 * render would be handed something the component was never written for.
 *
 * Narrowing instead of casting: the value handed to the component is the one the schema produced, so
 * a mismatch fails here, at the parse, naming the component.
 */
function parsedPreview<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  preview: unknown,
  component: string,
): T {
  const result = schema.safeParse(preview);
  if (!result.success) {
    throw new Error(
      `The ${component} preview does not match its own schema, so it cannot be rendered.`,
    );
  }
  return result.data;
}

/**
 * The `args` of one gallery entry's preview, parsed against the component's own schema.
 *
 * The interactive components are handed `{ status, args, respond }` rather than props, so their
 * previews are read as `preview.args`. Doing that with `?.preview as any` meant a missing entry threw
 * `Cannot read properties of undefined` a few lines later, inside a render, with nothing naming the
 * component whose entry had gone missing.
 */
function previewArgs<T>(
  gallery: ReadonlyArray<{ name: string; preview?: Record<string, unknown> }>,
  name: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  component: string,
): T {
  const entry = gallery.find((candidate) => candidate.name === name);
  if (!entry?.preview) {
    throw new Error(`${component} is registered without a preview to render.`);
  }
  return parsedPreview(schema, entry.preview.args, component);
}

test("all 20 new components are declared across the new gallery modules", () => {
  const allNewComponents = [
    ...SYSTEM_GALLERY,
    ...BUSINESS_GALLERY,
    ...VISUALS_GALLERY,
    ...TEAM_GALLERY,
    ...INTERACTIVE_GALLERY,
  ];

  expect(allNewComponents.length).toBe(20);

  const expectedNames = [
    // System (5)
    "showStatusSummary",
    "showTimeline",
    "showSteps",
    "showCodeDiff",
    "showLogStream",
    // Business (3)
    "showComparison",
    "showKpiGrid",
    "showCostBreakdown",
    // Visuals (4)
    "showGauge",
    "showFunnel",
    "showHeatmap",
    "showScatterPlot",
    // Team (4)
    "showSchedule",
    "showPersonProfile",
    "showKanban",
    "showFaq",
    // Interactive (4)
    "askFeedback",
    "askDateRange",
    "askConfirmation",
    "askMultiSelect",
  ];

  const byName = new Map(allNewComponents.map((c) => [c.name, c]));

  for (const name of expectedNames) {
    const comp = byName.get(name);
    expect(comp).toBeDefined();
    expect(comp?.title.length).toBeGreaterThan(0);
    expect(comp?.kind).toMatch(/^(card|chart|decision)$/);
    expect(comp?.description.length).toBeGreaterThan(0);
    expect(comp?.parameters).toBeDefined();
    expect(comp?.preview).toBeDefined();
    expect(typeof comp?.Component).toBe("function");
  }
});

test("all system components parse previews and render cleanly", () => {
  expect(SYSTEM_GALLERY.length).toBe(5);

  const statusPrev = SYSTEM_GALLERY.find(
    (g) => g.name === "showStatusSummary",
  )?.preview;
  expect(StatusSummaryProps.safeParse(statusPrev).success).toBe(true);
  const statusView = render(
    <StatusSummaryCard
      {...parsedPreview(StatusSummaryProps, statusPrev, "StatusSummaryCard")}
    />,
  );
  expect(statusView.getByText("Core Platform Status")).toBeTruthy();
  expect(statusView.getByText("Public Gateway")).toBeTruthy();

  const timelinePrev = SYSTEM_GALLERY.find(
    (g) => g.name === "showTimeline",
  )?.preview;
  expect(TimelineProps.safeParse(timelinePrev).success).toBe(true);
  const timelineView = render(
    <TimelineCard
      {...parsedPreview(TimelineProps, timelinePrev, "TimelineCard")}
    />,
  );
  expect(timelineView.getByText("Incident INC-842 Timeline")).toBeTruthy();
  expect(timelineView.getByText("Automated alert fired")).toBeTruthy();

  const stepsPrev = SYSTEM_GALLERY.find((g) => g.name === "showSteps")?.preview;
  expect(StepsProps.safeParse(stepsPrev).success).toBe(true);
  const stepsView = render(
    <StepsCard {...parsedPreview(StepsProps, stepsPrev, "StepsCard")} />,
  );
  expect(stepsView.getByText("Production Migration Checklist")).toBeTruthy();
  expect(stepsView.getByText("Schema migration")).toBeTruthy();

  const diffPrev = SYSTEM_GALLERY.find(
    (g) => g.name === "showCodeDiff",
  )?.preview;
  expect(CodeDiffProps.safeParse(diffPrev).success).toBe(true);
  const diffView = render(
    <CodeDiffCard
      {...parsedPreview(CodeDiffProps, diffPrev, "CodeDiffCard")}
    />,
  );
  expect(diffView.getByText("src/auth/jwt-verifier.ts")).toBeTruthy();
  expect(diffView.getByText("+3")).toBeTruthy();

  const logsPrev = SYSTEM_GALLERY.find(
    (g) => g.name === "showLogStream",
  )?.preview;
  expect(LogStreamProps.safeParse(logsPrev).success).toBe(true);
  const logsView = render(
    <LogStreamCard
      {...parsedPreview(LogStreamProps, logsPrev, "LogStreamCard")}
    />,
  );
  expect(logsView.getByText("Build logs")).toBeTruthy();
  expect(
    logsView.getByText("Starting container runtime bun:1.2-alpine"),
  ).toBeTruthy();
});

test("all business components parse previews and render cleanly", () => {
  expect(BUSINESS_GALLERY.length).toBe(3);

  const compPrev = BUSINESS_GALLERY.find(
    (g) => g.name === "showComparison",
  )?.preview;
  expect(ComparisonProps.safeParse(compPrev).success).toBe(true);
  const compView = render(
    <ComparisonCard
      {...parsedPreview(ComparisonProps, compPrev, "ComparisonCard")}
    />,
  );
  expect(compView.getByText("Hosting Tier Selection")).toBeTruthy();
  expect(compView.getByText("Standard")).toBeTruthy();
  expect(compView.getByText("Enterprise")).toBeTruthy();

  const kpiPrev = BUSINESS_GALLERY.find(
    (g) => g.name === "showKpiGrid",
  )?.preview;
  expect(KpiGridProps.safeParse(kpiPrev).success).toBe(true);
  const kpiView = render(
    <KpiGridCard {...parsedPreview(KpiGridProps, kpiPrev, "KpiGridCard")} />,
  );
  expect(kpiView.getByText("Q3 Core Metrics")).toBeTruthy();
  expect(kpiView.getByText("$182,400")).toBeTruthy();

  const costPrev = BUSINESS_GALLERY.find(
    (g) => g.name === "showCostBreakdown",
  )?.preview;
  expect(CostBreakdownProps.safeParse(costPrev).success).toBe(true);
  const costView = render(
    <CostBreakdownCard
      {...parsedPreview(CostBreakdownProps, costPrev, "CostBreakdownCard")}
    />,
  );
  expect(
    costView.getByText("AWS Monthly Infrastructure Estimate"),
  ).toBeTruthy();
  expect(costView.getByText("$681.80 / mo")).toBeTruthy();
});

test("all visual analytics components parse previews and render cleanly", () => {
  expect(VISUALS_GALLERY.length).toBe(4);

  const gaugePrev = VISUALS_GALLERY.find(
    (g) => g.name === "showGauge",
  )?.preview;
  expect(GaugeProps.safeParse(gaugePrev).success).toBe(true);
  const gaugeView = render(
    <GaugeCard {...parsedPreview(GaugeProps, gaugePrev, "GaugeCard")} />,
  );
  expect(gaugeView.getByText("API Availability SLA")).toBeTruthy();
  expect(gaugeView.getByText("99.85")).toBeTruthy();

  const funnelPrev = VISUALS_GALLERY.find(
    (g) => g.name === "showFunnel",
  )?.preview;
  expect(FunnelProps.safeParse(funnelPrev).success).toBe(true);
  const funnelView = render(
    <FunnelCard {...parsedPreview(FunnelProps, funnelPrev, "FunnelCard")} />,
  );
  expect(funnelView.getByText("Self-Serve Signup Funnel")).toBeTruthy();
  expect(funnelView.getByText("Landing Visits")).toBeTruthy();

  const heatmapPrev = VISUALS_GALLERY.find(
    (g) => g.name === "showHeatmap",
  )?.preview;
  expect(HeatmapProps.safeParse(heatmapPrev).success).toBe(true);
  const heatmapView = render(
    <HeatmapCard
      {...parsedPreview(HeatmapProps, heatmapPrev, "HeatmapCard")}
    />,
  );
  expect(heatmapView.getByText("Support Ticket Arrival Density")).toBeTruthy();
  expect(heatmapView.getByText("Mon")).toBeTruthy();

  const scatterPrev = VISUALS_GALLERY.find(
    (g) => g.name === "showScatterPlot",
  )?.preview;
  expect(ScatterPlotProps.safeParse(scatterPrev).success).toBe(true);
  const scatterView = render(
    <ScatterPlotCard
      {...parsedPreview(ScatterPlotProps, scatterPrev, "ScatterPlotCard")}
    />,
  );
  expect(
    scatterView.getByText("Query Latency vs Result Payload Size"),
  ).toBeTruthy();
  expect(scatterView.getByText("/users")).toBeTruthy();
});

test("all team and scheduling components parse previews and render cleanly", () => {
  expect(TEAM_GALLERY.length).toBe(4);

  const schedPrev = TEAM_GALLERY.find(
    (g) => g.name === "showSchedule",
  )?.preview;
  expect(ScheduleProps.safeParse(schedPrev).success).toBe(true);
  const schedView = render(
    <ScheduleCard
      {...parsedPreview(ScheduleProps, schedPrev, "ScheduleCard")}
    />,
  );
  expect(schedView.getByText("Today's Architecture Review")).toBeTruthy();
  expect(schedView.getByText("Keynote & Service Vision")).toBeTruthy();

  const profPrev = TEAM_GALLERY.find(
    (g) => g.name === "showPersonProfile",
  )?.preview;
  expect(PersonProfileProps.safeParse(profPrev).success).toBe(true);
  const profView = render(
    <PersonProfileCard
      {...parsedPreview(PersonProfileProps, profPrev, "PersonProfileCard")}
    />,
  );
  expect(profView.getByText("Marcus Vance")).toBeTruthy();
  expect(
    profView.getByText("Staff Reliability Engineer · Platform Infrastructure"),
  ).toBeTruthy();

  const kanbanPrev = TEAM_GALLERY.find((g) => g.name === "showKanban")?.preview;
  expect(KanbanProps.safeParse(kanbanPrev).success).toBe(true);
  const kanbanView = render(
    <KanbanCard {...parsedPreview(KanbanProps, kanbanPrev, "KanbanCard")} />,
  );
  expect(kanbanView.getByText("Sprint 42: Edge Deployment")).toBeTruthy();
  expect(kanbanView.getByText("To Do")).toBeTruthy();
  expect(kanbanView.getByText("Dual-write validation test")).toBeTruthy();

  const faqPrev = TEAM_GALLERY.find((g) => g.name === "showFaq")?.preview;
  expect(FaqProps.safeParse(faqPrev).success).toBe(true);
  const faqView = render(
    <FaqCard {...parsedPreview(FaqProps, faqPrev, "FaqCard")} />,
  );
  expect(faqView.getByText("Workspace Security Policy FAQ")).toBeTruthy();
  expect(
    faqView.getByText("How are Bot credentials and tokens encrypted?"),
  ).toBeTruthy();
});

test("askFeedback card handles rating selection and submission", async () => {
  const feedbackArgs = previewArgs(
    INTERACTIVE_GALLERY,
    "askFeedback",
    FeedbackCardProps,
    "FeedbackCard",
  );

  const responses: unknown[] = [];
  const view = render(
    <FeedbackCard
      status="executing"
      args={feedbackArgs}
      respond={async (ans) => {
        responses.push(ans);
      }}
    />,
  );

  expect(view.getByText("Incident Post-Mortem Quality")).toBeTruthy();
  const button4 = view.getByRole("button", { name: "4" });
  await user.click(button4);

  const commentInput = view.getByPlaceholderText(
    "Optional comment or suggestions…",
  );
  await user.type(commentInput, "Great details!");

  const submitButton = view.getByRole("button", { name: "Submit review" });
  await user.click(submitButton);

  expect(responses).toEqual([
    {
      rating: 4,
      comment: "Great details!",
    },
  ]);
});

test("askDateRange card handles preset selection and range submission", async () => {
  const dateRangeArgs = previewArgs(
    INTERACTIVE_GALLERY,
    "askDateRange",
    DateRangeProps,
    "DateRangeCard",
  );

  const responses: unknown[] = [];
  const view = render(
    <DateRangeCard
      status="executing"
      args={dateRangeArgs}
      respond={async (ans) => {
        responses.push(ans);
      }}
    />,
  );

  expect(view.getByText("Export Audit Log Window")).toBeTruthy();
  const preset7d = view.getByRole("button", { name: "Last 7 days" });
  await user.click(preset7d);

  const submitButton = view.getByRole("button", { name: "Generate export" });
  await user.click(submitButton);

  expect(responses).toEqual([
    {
      preset: "Last 7 days",
      startDate: "2026-09-15",
      endDate: "2026-09-22",
    },
  ]);
});

test("askConfirmation card protects dangerous actions until exact keyword matches", async () => {
  const confirmArgs = previewArgs(
    INTERACTIVE_GALLERY,
    "askConfirmation",
    ConfirmationProps,
    "ConfirmationCard",
  );

  const responses: unknown[] = [];
  const view = render(
    <ConfirmationCard
      status="executing"
      args={confirmArgs}
      respond={async (ans) => {
        responses.push(ans);
      }}
    />,
  );

  expect(view.getByText("Tear Down Test Cluster")).toBeTruthy();
  const executeBtn = view.getByRole("button", {
    name: "Destroy staging cluster",
  });
  expect(executeBtn.hasAttribute("disabled")).toBe(true);

  const input = view.getByPlaceholderText('Type "TEARDOWN" to confirm');
  await user.type(input, "WRONG");
  expect(executeBtn.hasAttribute("disabled")).toBe(true);

  await user.clear(input);
  await user.type(input, "TEARDOWN");
  expect(executeBtn.hasAttribute("disabled")).toBe(false);

  await user.click(executeBtn);
  expect(responses).toEqual([
    {
      confirmed: true,
      keywordEntered: "TEARDOWN",
    },
  ]);
});

test("askMultiSelect card handles option toggles, toggle all, and submission", async () => {
  const multiArgs = previewArgs(
    INTERACTIVE_GALLERY,
    "askMultiSelect",
    MultiSelectProps,
    "MultiSelectCard",
  );

  const responses: unknown[] = [];
  const view = render(
    <MultiSelectCard
      status="executing"
      args={multiArgs}
      respond={async (ans) => {
        responses.push(ans);
      }}
    />,
  );

  expect(view.getByText("Target Deployment Regions")).toBeTruthy();
  const toggleBtn = view.getByRole("button", { name: /Asia Pacific/ });
  await user.click(toggleBtn);

  const submitBtn = view.getByRole("button", { name: "Deploy to selected" });
  await user.click(submitBtn);

  expect(responses).toHaveLength(1);
  const first = responses[0] as { selectedIds: string[]; count: number };
  expect(first.count).toBe(3);
  expect(first.selectedIds).toContain("us-east-1");
  expect(first.selectedIds).toContain("eu-central-1");
  expect(first.selectedIds).toContain("ap-southeast-1");
});
