import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame, type Tone } from "./frame";
import { STATE_COLOURS, seriesColour } from "./palette";

/* -------------------------------------------------------------------------- Gauge Meter */

export const GaugeProps = z.object({
  title: z.string().describe("Gauge metric name"),
  caption: z.string().optional().describe("Context or threshold explanation"),
  value: z.number().describe("Current metric value"),
  min: z.number().default(0).describe("Lower bound, defaults to 0"),
  max: z.number().default(100).describe("Upper bound, defaults to 100"),
  unit: z.string().optional().describe("Unit suffix, e.g. '%', 'ms', 'req/s'"),
  statusTone: z.enum(["positive", "caution", "negative", "neutral"]).optional(),
  target: z.number().optional().describe("Target baseline marker value"),
});

export function GaugeCard(props: Partial<z.infer<typeof GaugeProps>>) {
  const {
    title = "Gauge",
    caption,
    value = 0,
    min = 0,
    max = 100,
    unit = "",
    statusTone = "positive",
    target,
  } = props;
  const clamped = Math.max(min, Math.min(value, max));
  const range = max - min || 1;
  const fraction = (clamped - min) / range;

  // Arc geometry: 180-degree semicircular gauge
  const radius = 64;
  const strokeWidth = 14;
  const cx = 100;
  const cy = 84;
  const arcCircumference = Math.PI * radius;
  const strokeDashoffset = arcCircumference * (1 - fraction);

  const colour =
    statusTone === "positive"
      ? STATE_COLOURS.positive
      : statusTone === "negative"
        ? STATE_COLOURS.negative
        : statusTone === "caution"
          ? STATE_COLOURS.caution
          : "#6366f1";

  return (
    <GalleryFrame
      action={<Badge tone={statusTone as Tone}>{statusTone}</Badge>}
      caption={caption}
      title={title}
    >
      <div className="flex flex-col items-center justify-center py-2">
        <div className="relative flex items-center justify-center">
          <svg
            aria-hidden="true"
            className="overflow-visible"
            height={96}
            viewBox="0 0 200 100"
            width={192}
          >
            {/* Background track */}
            <path
              d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
              fill="none"
              stroke="currentColor"
              className="text-foreground/10"
              strokeLinecap="round"
              strokeWidth={strokeWidth}
            />
            {/* Value fill arc */}
            <path
              d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
              fill="none"
              stroke={colour}
              strokeDasharray={arcCircumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              strokeWidth={strokeWidth}
            />
            {/* Optional target tick mark */}
            {target !== undefined && target >= min && target <= max
              ? (() => {
                  const targetAngle = Math.PI * (1 - (target - min) / range);
                  const tx1 = cx + (radius - 10) * Math.cos(targetAngle);
                  const ty1 = cy - (radius - 10) * Math.sin(targetAngle);
                  const tx2 = cx + (radius + 10) * Math.cos(targetAngle);
                  const ty2 = cy - (radius + 10) * Math.sin(targetAngle);
                  return (
                    <line
                      key="target-marker"
                      stroke="currentColor"
                      className="text-foreground"
                      strokeWidth={2}
                      strokeDasharray="2 2"
                      x1={tx1}
                      x2={tx2}
                      y1={ty1}
                      y2={ty2}
                    />
                  );
                })()
              : null}
          </svg>
          <div className="absolute bottom-2 flex flex-col items-center">
            <span className="font-extrabold text-2xl tabular-nums tracking-tight">
              {value}
              {unit ? (
                <span className="ml-0.5 text-sm font-semibold">{unit}</span>
              ) : null}
            </span>
          </div>
        </div>
        <div className="mt-1 flex w-48 justify-between text-xs text-muted-foreground tabular-nums">
          <span>
            {min}
            {unit}
          </span>
          {target !== undefined ? (
            <span>
              Target: {target}
              {unit}
            </span>
          ) : null}
          <span>
            {max}
            {unit}
          </span>
        </div>
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Funnel Chart */

export const FunnelProps = z.object({
  title: z.string().describe("Funnel name, e.g. 'User Onboarding Pipeline'"),
  caption: z
    .string()
    .optional()
    .describe("Summary of drop-off rate or timeframe"),
  stages: z
    .array(
      z.object({
        name: z.string().describe("Funnel stage name"),
        count: z.number().describe("Volume or count at this stage"),
        percentage: z
          .number()
          .optional()
          .describe("Percentage relative to first stage"),
        dropOffRate: z
          .string()
          .optional()
          .describe("Drop-off percentage from previous stage"),
      }),
    )
    .min(2)
    .max(6)
    .describe("Ordered stages from top to bottom"),
});

export function FunnelCard(props: Partial<z.infer<typeof FunnelProps>>) {
  const { title = "Funnel", caption, stages = [] } = props;
  const firstCount = stages[0]?.count || 1;

  return (
    <GalleryFrame caption={caption} title={title}>
      <div className="space-y-2.5 py-1">
        {stages.map((stage, idx) => {
          const widthPct = Math.max(
            15,
            Math.min(100, Math.round((stage.count / firstCount) * 100)),
          );
          const convRate =
            stage.percentage ?? Math.round((stage.count / firstCount) * 100);

          return (
            <div className="space-y-1" key={stage.name}>
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium truncate">{stage.name}</span>
                <div className="flex items-center gap-3 tabular-nums">
                  <span className="font-semibold">
                    {stage.count.toLocaleString()}
                  </span>
                  <span className="text-muted-foreground w-10 text-right">
                    {convRate}%
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-6 flex-1 overflow-hidden rounded bg-foreground/5 flex items-center">
                  <div
                    className="h-full rounded transition-[width] flex items-center px-2 text-[11px] font-semibold text-white truncate"
                    style={{
                      width: `${widthPct}%`,
                      backgroundColor: seriesColour(idx),
                    }}
                  >
                    {widthPct > 25 ? `${convRate}%` : ""}
                  </div>
                </div>
                {stage.dropOffRate ? (
                  <span className="text-[10px] text-muted-foreground shrink-0 w-16 text-right">
                    -{stage.dropOffRate}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Heatmap */

export const HeatmapProps = z.object({
  title: z.string().describe("Heatmap title"),
  caption: z.string().optional().describe("Legend or time unit context"),
  xAxis: z.array(z.string()).describe("Column labels (e.g. days of week)"),
  yAxis: z.array(z.string()).describe("Row labels (e.g. hours or shifts)"),
  cells: z
    .array(
      z.object({
        x: z.number().describe("0-based column index"),
        y: z.number().describe("0-based row index"),
        value: z.number().describe("Density value"),
        label: z.string().optional().describe("Tooltip or readout label"),
      }),
    )
    .describe("Matrix cell values"),
  unit: z.string().optional().describe("Unit of measurement, e.g. 'events'"),
});

export function HeatmapCard(props: Partial<z.infer<typeof HeatmapProps>>) {
  const {
    title = "Activity heatmap",
    caption,
    xAxis = [],
    yAxis = [],
    cells = [],
    unit = "",
  } = props;
  const values = cells.map((c) => c.value);
  const max = Math.max(...values, 1);

  // Map coordinate key "x,y" to cell
  const gridMap = new Map<string, number>();
  for (const c of cells) {
    gridMap.set(`${c.x},${c.y}`, c.value);
  }

  return (
    <GalleryFrame caption={caption} title={title}>
      <div className="overflow-x-auto py-1">
        <div className="inline-block min-w-full">
          {/* Column headers */}
          <div className="flex pl-16 mb-1 gap-1">
            {xAxis.map((xLabel) => (
              <div
                className="flex-1 min-w-[28px] text-center text-[10px] text-muted-foreground font-medium truncate"
                key={xLabel}
              >
                {xLabel}
              </div>
            ))}
          </div>
          {/* Rows */}
          <div className="space-y-1">
            {yAxis.map((yLabel, yIdx) => (
              <div className="flex items-center gap-1" key={yLabel}>
                <span className="w-16 shrink-0 truncate text-right pr-2 text-[10px] text-muted-foreground font-medium">
                  {yLabel}
                </span>
                <div className="flex flex-1 gap-1">
                  {xAxis.map((_, xIdx) => {
                    const val = gridMap.get(`${xIdx},${yIdx}`) ?? 0;
                    const intensity = max > 0 ? val / max : 0;
                    return (
                      <div
                        className="flex-1 min-w-[28px] h-7 rounded-[4px] border border-border/40 transition-colors flex items-center justify-center text-[10px] font-mono tabular-nums"
                        key={`${xIdx}-${yIdx}`}
                        style={{
                          backgroundColor:
                            val === 0
                              ? "transparent"
                              : `rgba(99, 102, 241, ${Math.max(0.15, Math.min(intensity, 0.95))})`,
                          color: intensity > 0.5 ? "#ffffff" : "inherit",
                        }}
                        title={`${xAxis[xIdx]}, ${yLabel}: ${val} ${unit}`}
                      >
                        {val > 0 ? val : ""}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Scatter Plot */

export const ScatterPlotProps = z.object({
  title: z.string().describe("Scatter plot title"),
  caption: z.string().optional().describe("Summary of observed correlation"),
  xLabel: z.string().describe("Label for horizontal x-axis"),
  yLabel: z.string().describe("Label for vertical y-axis"),
  points: z
    .array(
      z.object({
        x: z.number().describe("X coordinate value"),
        y: z.number().describe("Y coordinate value"),
        label: z.string().optional().describe("Point label"),
        group: z.string().optional().describe("Category group for coloring"),
      }),
    )
    .min(2)
    .describe("Points to plot"),
});

export function ScatterPlotCard(
  props: Partial<z.infer<typeof ScatterPlotProps>>,
) {
  const {
    title = "Scatter plot",
    caption,
    xLabel = "X",
    yLabel = "Y",
    points = [],
  } = props;
  const width = 480;
  const height = 180;
  const pad = { top: 12, right: 16, bottom: 26, left: 36 };

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs, 0);
  const xMax = Math.max(...xs, 1);
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys, 1);

  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const toSvgX = (x: number) =>
    pad.left + ((x - xMin) / xSpan) * (width - pad.left - pad.right);
  const toSvgY = (y: number) =>
    pad.top + (1 - (y - yMin) / ySpan) * (height - pad.top - pad.bottom);

  // Collect unique groups
  const groups = Array.from(
    new Set(points.map((p) => p.group).filter(Boolean)),
  ) as string[];

  return (
    <GalleryFrame caption={caption} title={title}>
      <div className="relative">
        <svg
          aria-hidden="true"
          className="w-full overflow-visible"
          height={height}
          preserveAspectRatio="none"
          viewBox={`0 0 ${width} ${height}`}
        >
          {/* Guide gridlines */}
          {[0, 0.5, 1].map((f) => (
            <line
              className="stroke-border"
              key={f}
              strokeDasharray="2 2"
              x1={pad.left}
              x2={width - pad.right}
              y1={pad.top + f * (height - pad.top - pad.bottom)}
              y2={pad.top + f * (height - pad.top - pad.bottom)}
            />
          ))}
          {/*
           * The vertical axis label. `pad.left` is 36 rather than the 16 the right pad uses
           * because this text lives in that gutter: without it the prop was accepted, passed by
           * every caller, and drawn nowhere, which is worse than not accepting it.
           */}
          <text
            className="fill-muted-foreground text-[10px] select-none"
            textAnchor="middle"
            transform={`rotate(-90 10 ${height / 2})`}
            x={10}
            y={height / 2}
          >
            {yLabel}
          </text>
          {/* Points */}
          {points.map((p, idx) => {
            const groupIdx = p.group ? groups.indexOf(p.group) : 0;
            const colour = seriesColour(groupIdx);
            return (
              <g key={`${p.label ?? idx}-${p.x}-${p.y}`}>
                <circle
                  cx={toSvgX(p.x)}
                  cy={toSvgY(p.y)}
                  fill={colour}
                  fillOpacity={0.8}
                  r={5}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                />
                {p.label ? (
                  <text
                    className="fill-muted-foreground text-[10px] select-none"
                    dx={7}
                    dy={3}
                    x={toSvgX(p.x)}
                    y={toSvgY(p.y)}
                  >
                    {p.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        <div className="mt-1 flex justify-between text-[11px] text-muted-foreground px-2">
          <span>
            {xLabel} ({xMin})
          </span>
          <span>
            {xLabel} ({xMax})
          </span>
        </div>
      </div>
      {groups.length > 1 ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {groups.map((group, idx) => (
            <li className="flex items-center gap-1.5 text-xs" key={group}>
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: seriesColour(idx) }}
              />
              <span className="text-muted-foreground">{group}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- GALLERY Export */

export const GALLERY: GalleryComponent[] = [
  {
    name: "showGauge",
    title: "Gauge meter",
    kind: "chart",
    description:
      "Show a semicircular gauge meter for percentages, quota limits, CPU/memory usage, or satisfaction scores with status thresholds.",
    parameters: GaugeProps,
    Component: GaugeCard as GalleryComponent["Component"],
    preview: {
      title: "API Availability SLA",
      caption: "Current rolling 30-day performance",
      value: 99.85,
      min: 95,
      max: 100,
      unit: "%",
      statusTone: "positive",
      target: 99.9,
    },
    confirmation: "The gauge meter is now on screen for the person.",
  },
  {
    name: "showFunnel",
    title: "Funnel chart",
    kind: "chart",
    description:
      "Show conversion or drop-off through tiered sequential stages such as user onboarding, checkout flow, or recruitment pipelines.",
    parameters: FunnelProps,
    Component: FunnelCard as GalleryComponent["Component"],
    preview: {
      title: "Self-Serve Signup Funnel",
      caption: "Weekly cohort of visitors converting to active users",
      stages: [
        { name: "Landing Visits", count: 12400 },
        { name: "Account Created", count: 4820, dropOffRate: "61%" },
        { name: "Invited Coworker", count: 2150, dropOffRate: "55%" },
        { name: "Created First Bot", count: 1680, dropOffRate: "22%" },
        { name: "Subscribed Plan", count: 420, dropOffRate: "75%" },
      ],
    },
    confirmation: "The funnel chart is now on screen for the person.",
  },
  {
    name: "showHeatmap",
    title: "Activity heatmap",
    kind: "chart",
    description:
      "Display a 2D intensity grid representing activity density over time, days of week, or category distributions.",
    parameters: HeatmapProps,
    Component: HeatmapCard as GalleryComponent["Component"],
    preview: {
      title: "Support Ticket Arrival Density",
      caption: "Aggregated ticket spikes across business hours (UTC)",
      xAxis: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      yAxis: ["Morning", "Afternoon", "Evening", "Night"],
      unit: "tickets",
      cells: [
        { x: 0, y: 0, value: 42 },
        { x: 0, y: 1, value: 85 },
        { x: 0, y: 2, value: 31 },
        { x: 0, y: 3, value: 8 },
        { x: 1, y: 0, value: 54 },
        { x: 1, y: 1, value: 92 },
        { x: 1, y: 2, value: 40 },
        { x: 1, y: 3, value: 12 },
        { x: 2, y: 0, value: 48 },
        { x: 2, y: 1, value: 76 },
        { x: 2, y: 2, value: 35 },
        { x: 2, y: 3, value: 6 },
        { x: 3, y: 0, value: 60 },
        { x: 3, y: 1, value: 68 },
        { x: 3, y: 2, value: 29 },
        { x: 3, y: 3, value: 9 },
        { x: 4, y: 0, value: 38 },
        { x: 4, y: 1, value: 44 },
        { x: 4, y: 2, value: 18 },
        { x: 4, y: 3, value: 4 },
        { x: 5, y: 0, value: 8 },
        { x: 5, y: 1, value: 12 },
        { x: 5, y: 2, value: 7 },
        { x: 5, y: 3, value: 2 },
        { x: 6, y: 0, value: 6 },
        { x: 6, y: 1, value: 10 },
        { x: 6, y: 2, value: 5 },
        { x: 6, y: 3, value: 3 },
      ],
    },
    confirmation: "The activity heatmap is now on screen for the person.",
  },
  {
    name: "showScatterPlot",
    title: "Scatter plot",
    kind: "chart",
    description:
      "Plot individual observations on a 2D coordinate plane to visualize distributions, correlation, or clustering across two variables.",
    parameters: ScatterPlotProps,
    Component: ScatterPlotCard as GalleryComponent["Component"],
    preview: {
      title: "Query Latency vs Result Payload Size",
      caption: "Observation of 8 microservice endpoints under peak load",
      xLabel: "Payload (KB)",
      yLabel: "Latency (ms)",
      points: [
        { x: 12, y: 24, label: "/users", group: "Read" },
        { x: 45, y: 62, label: "/search", group: "Read" },
        { x: 180, y: 210, label: "/export", group: "Read" },
        { x: 8, y: 48, label: "/auth", group: "Write" },
        { x: 28, y: 95, label: "/checkout", group: "Write" },
        { x: 95, y: 140, label: "/upload", group: "Write" },
      ],
    },
    confirmation: "The scatter plot is now on screen for the person.",
  },
];
