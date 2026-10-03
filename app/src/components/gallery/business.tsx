import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame, type Tone } from "./frame";

/* -------------------------------------------------------------------------- Comparison */

export const ComparisonProps = z.object({
  title: z.string().describe("Comparison title"),
  caption: z.string().optional().describe("Summary or guidance on the options"),
  options: z
    .array(
      z.object({
        name: z.string().describe("Option name"),
        subtitle: z
          .string()
          .optional()
          .describe("Short subtitle, e.g. price or audience"),
        highlighted: z
          .boolean()
          .optional()
          .describe("Whether this is the recommended choice"),
        badge: z
          .string()
          .optional()
          .describe("Badge label, e.g. 'Recommended'"),
        features: z
          .array(
            z.object({
              label: z.string().describe("Feature name"),
              value: z
                .union([z.boolean(), z.string()])
                .describe("Checkmark, cross, or value string"),
            }),
          )
          .describe("Feature comparison rows"),
      }),
    )
    .min(2)
    .max(4)
    .describe("2 to 4 options to compare side by side"),
});

export function ComparisonCard(
  props: Partial<z.infer<typeof ComparisonProps>>,
) {
  const { title, caption, options = [] } = props;

  return (
    <GalleryFrame caption={caption} title={title ?? "Comparison"}>
      <div
        className={`grid gap-3 ${options.length === 2 ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-3"}`}
      >
        {options.map((opt) => (
          <div
            className={`flex flex-col justify-between rounded-lg border p-3.5 transition-colors ${
              opt.highlighted
                ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                : "border-border bg-card"
            }`}
            key={opt.name}
          >
            <div>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="font-semibold text-sm">{opt.name}</h4>
                  {opt.subtitle ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {opt.subtitle}
                    </p>
                  ) : null}
                </div>
                {opt.badge ? (
                  <Badge tone={opt.highlighted ? "positive" : "neutral"}>
                    {opt.badge}
                  </Badge>
                ) : null}
              </div>
              <ul className="mt-4 space-y-2 border-t border-border/60 pt-3 text-xs">
                {opt.features.map((feat) => (
                  <li
                    className="flex items-center justify-between gap-2"
                    key={feat.label}
                  >
                    <span className="text-muted-foreground truncate">
                      {feat.label}
                    </span>
                    <span className="font-medium shrink-0">
                      {typeof feat.value === "boolean" ? (
                        feat.value ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                            ✓
                          </span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )
                      ) : (
                        feat.value
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- KPI Grid */

const tone = z.enum(["neutral", "positive", "caution", "negative"]);

export const KpiGridProps = z.object({
  title: z.string().describe("What these KPIs track"),
  caption: z.string().optional().describe("Timeframe or benchmark context"),
  kpis: z
    .array(
      z.object({
        label: z.string().describe("Metric name"),
        value: z.string().describe("Formatted main value"),
        target: z.string().optional().describe("Goal or baseline"),
        change: z.string().optional().describe("Movement, e.g. '+14.2%'"),
        changeTone: tone.optional().describe("Semantic tone of the movement"),
        subtext: z.string().optional().describe("Supporting detail"),
      }),
    )
    .min(1)
    .max(6)
    .describe("Up to 6 KPI cards"),
});

export function KpiGridCard(props: Partial<z.infer<typeof KpiGridProps>>) {
  const { title, caption, kpis = [] } = props;

  return (
    <GalleryFrame
      caption={caption}
      title={title ?? "Key performance indicators"}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {kpis.map((kpi) => (
          <div
            className="flex flex-col justify-between rounded-lg border border-border bg-card p-3"
            key={kpi.label}
          >
            <div>
              <p className="truncate text-xs text-muted-foreground">
                {kpi.label}
              </p>
              <p className="mt-1 font-bold text-xl tabular-nums">{kpi.value}</p>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[11px]">
              {kpi.change ? (
                <Badge tone={kpi.changeTone as Tone}>{kpi.change}</Badge>
              ) : null}
              {kpi.target ? (
                <span className="text-muted-foreground truncate">
                  Goal: {kpi.target}
                </span>
              ) : null}
              {kpi.subtext ? (
                <span className="w-full text-muted-foreground/80 mt-0.5">
                  {kpi.subtext}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Cost Breakdown */

export const CostBreakdownProps = z.object({
  title: z.string().describe("Invoice or cost estimate title"),
  period: z.string().optional().describe("Billing cycle or timeframe"),
  currency: z.string().default("$").describe("Currency symbol or ISO code"),
  items: z
    .array(
      z.object({
        description: z.string().describe("Line item name or service"),
        category: z
          .string()
          .optional()
          .describe("Category tag, e.g. 'Compute'"),
        quantity: z
          .union([z.number(), z.string()])
          .optional()
          .describe("Units or quantity"),
        amount: z.string().describe("Line total amount"),
      }),
    )
    .min(1)
    .describe("Itemized line items"),
  subtotal: z.string().optional().describe("Subtotal before tax or credits"),
  discountOrTax: z
    .array(
      z.object({
        label: z.string(),
        amount: z.string(),
        isNegative: z.boolean().optional(),
      }),
    )
    .optional()
    .describe("Taxes, credits, or fee adjustments"),
  total: z.string().describe("Grand total amount"),
});

export function CostBreakdownCard(
  props: Partial<z.infer<typeof CostBreakdownProps>>,
) {
  const {
    title,
    period,
    items = [],
    subtotal,
    discountOrTax,
    total = "0",
  } = props;

  return (
    <GalleryFrame
      action={period ? <Badge>{period}</Badge> : undefined}
      title={title ?? "Cost breakdown"}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="pb-2 font-medium">Item</th>
              <th className="pb-2 text-right font-medium">Qty</th>
              <th className="pb-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {items.map((item) => (
              <tr key={`${item.description}-${item.amount}`}>
                <td className="py-2.5">
                  <span className="font-medium text-foreground">
                    {item.description}
                  </span>
                  {item.category ? (
                    <span className="ml-2 rounded bg-foreground/5 px-1 py-0.5 text-[10px] text-muted-foreground">
                      {item.category}
                    </span>
                  ) : null}
                </td>
                <td className="py-2.5 text-right text-muted-foreground tabular-nums">
                  {item.quantity ?? "—"}
                </td>
                <td className="py-2.5 text-right font-medium tabular-nums">
                  {item.amount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs">
        {subtotal ? (
          <div className="flex justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span className="tabular-nums font-medium">{subtotal}</span>
          </div>
        ) : null}
        {discountOrTax?.map((adj) => (
          <div
            className={`flex justify-between ${
              adj.isNegative
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground"
            }`}
            key={adj.label}
          >
            <span>{adj.label}</span>
            <span className="tabular-nums font-medium">
              {adj.isNegative ? `-${adj.amount}` : adj.amount}
            </span>
          </div>
        ))}
        <div className="flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
          <span>Total</span>
          <span className="text-base tabular-nums">{total}</span>
        </div>
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- GALLERY Export */

export const GALLERY: GalleryComponent[] = [
  {
    name: "showComparison",
    title: "Comparison",
    kind: "card",
    description:
      "Compare two to four plans, proposals, or architecture options side-by-side with features and recommendations.",
    parameters: ComparisonProps,
    Component: ComparisonCard as GalleryComponent["Component"],
    preview: {
      title: "Hosting Tier Selection",
      caption: "Recommended for teams scaling to multi-region",
      options: [
        {
          name: "Standard",
          subtitle: "$49 / month",
          features: [
            { label: "Dedicated CPUs", value: "2 vCPU" },
            { label: "Memory", value: "4 GB" },
            { label: "Multi-region", value: false },
            { label: "SLA Guarantee", value: "99.9%" },
          ],
        },
        {
          name: "Enterprise",
          subtitle: "$199 / month",
          highlighted: true,
          badge: "Recommended",
          features: [
            { label: "Dedicated CPUs", value: "8 vCPU" },
            { label: "Memory", value: "32 GB" },
            { label: "Multi-region", value: true },
            { label: "SLA Guarantee", value: "99.99%" },
          ],
        },
      ],
    },
    confirmation: "The comparison card is now on screen for the person.",
  },
  {
    name: "showKpiGrid",
    title: "KPI grid",
    kind: "card",
    description:
      "Display up to 6 executive metrics or performance indicators in a compact structured grid with movements and targets.",
    parameters: KpiGridProps,
    Component: KpiGridCard as GalleryComponent["Component"],
    preview: {
      title: "Q3 Core Metrics",
      caption: "Consolidated across engineering & growth",
      kpis: [
        {
          label: "Monthly Recurring Revenue",
          value: "$182,400",
          change: "+14.2%",
          changeTone: "positive",
          target: "$175k",
        },
        {
          label: "Net Retention Rate",
          value: "112%",
          change: "+2.1pt",
          changeTone: "positive",
        },
        {
          label: "Mean Time to Resolve",
          value: "24m",
          change: "-18%",
          changeTone: "positive",
          target: "< 30m",
        },
        {
          label: "Infrastructure Cost",
          value: "$4,210",
          change: "+8.4%",
          changeTone: "caution",
          subtext: "Within budget",
        },
      ],
    },
    confirmation: "The KPI grid is now on screen for the person.",
  },
  {
    name: "showCostBreakdown",
    title: "Cost breakdown",
    kind: "card",
    description:
      "Show an itemized bill, quote, or cloud resource cost estimate with quantities, subtotals, and discounts.",
    parameters: CostBreakdownProps,
    Component: CostBreakdownCard as GalleryComponent["Component"],
    preview: {
      title: "AWS Monthly Infrastructure Estimate",
      period: "Estimated for next cycle",
      items: [
        {
          description: "Amazon EC2 (t4g.xlarge x 4)",
          category: "Compute",
          quantity: "2,880 hrs",
          amount: "$386.40",
        },
        {
          description: "Amazon RDS Multi-AZ PostgreSQL",
          category: "Database",
          quantity: "1 instance",
          amount: "$248.00",
        },
        {
          description: "CloudFront CDN Egress",
          category: "Network",
          quantity: "4.2 TB",
          amount: "$126.00",
        },
        {
          description: "S3 Standard Storage",
          category: "Storage",
          quantity: "1.8 TB",
          amount: "$41.40",
        },
      ],
      subtotal: "$801.80",
      discountOrTax: [
        {
          label: "Enterprise Savings Plan (1yr)",
          amount: "$120.00",
          isNegative: true,
        },
      ],
      total: "$681.80 / mo",
    },
    confirmation: "The cost breakdown is now on screen for the person.",
  },
];
