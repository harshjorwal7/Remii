import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame, type Tone } from "./frame";

/* -------------------------------------------------------------------------- Schedule */

export const ScheduleProps = z.object({
  title: z.string().describe("Calendar or itinerary title"),
  date: z
    .string()
    .describe("Date or day representation, e.g. 'Wednesday, Oct 15'"),
  caption: z.string().optional().describe("Summary or timezone notice"),
  events: z
    .array(
      z.object({
        time: z.string().describe("Start time or interval, e.g. '09:30 AM'"),
        title: z.string().describe("Event or meeting name"),
        duration: z.string().optional().describe("Duration, e.g. '45m'"),
        location: z
          .string()
          .optional()
          .describe("Location, room, or video link"),
        tag: z.string().optional().describe("Category label, e.g. 'Sync'"),
        tagTone: z
          .enum(["neutral", "positive", "caution", "negative"])
          .optional(),
      }),
    )
    .min(1)
    .describe("Chronological list of scheduled items"),
});

export function ScheduleCard(props: Partial<z.infer<typeof ScheduleProps>>) {
  const { title = "Schedule", date = "Today", caption, events = [] } = props;

  return (
    <GalleryFrame
      action={<Badge tone="neutral">{date}</Badge>}
      caption={caption}
      title={title}
    >
      <div className="space-y-2.5">
        {events.map((evt) => (
          <div
            className="flex items-start gap-3 rounded-lg border border-border/80 bg-card p-2.5 transition-colors"
            key={`${evt.time}:${evt.title}`}
          >
            <div className="w-20 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
              {evt.time}
              {evt.duration ? (
                <span className="block text-[10px] font-normal text-muted-foreground/75">
                  ({evt.duration})
                </span>
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium text-sm">{evt.title}</p>
                {evt.tag ? (
                  <Badge tone={evt.tagTone as Tone}>{evt.tag}</Badge>
                ) : null}
              </div>
              {evt.location ? (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  📍 {evt.location}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Contact Profile */

const personStatus = z.enum(["active", "away", "on_call", "offline"]);

export const PersonProfileProps = z.object({
  name: z.string().describe("Person's full name"),
  role: z.string().describe("Job title or functional role"),
  department: z.string().optional().describe("Department or team name"),
  email: z.string().optional().describe("Work email address"),
  timezone: z.string().optional().describe("Current local timezone or city"),
  status: personStatus.optional().describe("Availability status"),
  tags: z.array(z.string()).optional().describe("Expertise or ownership areas"),
});

const PERSON_STATUS_LABELS: Record<
  z.infer<typeof personStatus>,
  { label: string; tone: Tone }
> = {
  active: { label: "Available", tone: "positive" },
  on_call: { label: "On Call", tone: "caution" },
  away: { label: "Away", tone: "neutral" },
  offline: { label: "Offline", tone: "neutral" },
};

export function PersonProfileCard(
  props: Partial<z.infer<typeof PersonProfileProps>>,
) {
  const {
    name = "Coworker",
    role = "Team Member",
    department,
    email,
    timezone,
    status = "active",
    tags = [],
  } = props;
  const statusMeta = PERSON_STATUS_LABELS[status] ?? {
    label: status,
    tone: "neutral",
  };

  // Initials for avatar
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <GalleryFrame
      action={<Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>}
      title="Contact card"
    >
      <div className="flex items-start gap-4">
        <div
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-base text-primary select-none"
        >
          {initials || "👤"}
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold text-base">{name}</h4>
          <p className="text-xs text-muted-foreground">
            {role}
            {department ? ` · ${department}` : ""}
          </p>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground border-t border-border/60 pt-2.5">
            {email ? (
              <div className="truncate">
                <span className="font-medium text-foreground">Email: </span>
                {email}
              </div>
            ) : null}
            {timezone ? (
              <div className="truncate">
                <span className="font-medium text-foreground">Timezone: </span>
                {timezone}
              </div>
            ) : null}
          </div>

          {tags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  className="rounded bg-foreground/5 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                  key={tag}
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Kanban Board */

export const KanbanProps = z.object({
  title: z.string().describe("Board or sprint title"),
  caption: z.string().optional().describe("Sprint goal or status overview"),
  columns: z
    .array(
      z.object({
        name: z.string().describe("Column title, e.g. 'In Progress'"),
        cards: z
          .array(
            z.object({
              title: z.string().describe("Task name"),
              priority: z.enum(["low", "medium", "high"]).optional(),
              assignee: z.string().optional(),
            }),
          )
          .describe("Cards in this column"),
      }),
    )
    .min(2)
    .max(4)
    .describe("Columns to display"),
});

const PRIORITY_TONES: Record<string, Tone> = {
  high: "negative",
  medium: "caution",
  low: "neutral",
};

export function KanbanCard(props: Partial<z.infer<typeof KanbanProps>>) {
  const { title = "Kanban board", caption, columns = [] } = props;

  return (
    <GalleryFrame caption={caption} title={title}>
      <div
        className={`grid gap-3 ${columns.length === 2 ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-3"}`}
      >
        {columns.map((col) => (
          <div
            className="flex flex-col rounded-lg bg-muted/40 p-2.5"
            key={col.name}
          >
            <div className="flex items-center justify-between pb-2">
              <span className="font-medium text-xs text-muted-foreground">
                {col.name}
              </span>
              <span className="rounded-full bg-foreground/10 px-1.5 py-0.2 text-[10px] font-semibold tabular-nums">
                {col.cards.length}
              </span>
            </div>
            <div className="space-y-2">
              {col.cards.map((item) => (
                <div
                  className="rounded-md border border-border bg-card p-2 text-xs shadow-2xs"
                  key={item.title}
                >
                  <p className="font-medium text-foreground leading-snug">
                    {item.title}
                  </p>
                  <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                    {item.priority ? (
                      <Badge tone={PRIORITY_TONES[item.priority]}>
                        {item.priority}
                      </Badge>
                    ) : (
                      <span />
                    )}
                    {item.assignee ? <span>{item.assignee}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- FAQ List */

export const FaqProps = z.object({
  title: z.string().describe("FAQ list title"),
  caption: z.string().optional().describe("Brief note or scope"),
  items: z
    .array(
      z.object({
        question: z.string().describe("Frequently asked question"),
        answer: z.string().describe("Concise answer"),
        category: z.string().optional().describe("Topic category badge"),
      }),
    )
    .min(1)
    .describe("List of questions and answers"),
});

export function FaqCard(props: Partial<z.infer<typeof FaqProps>>) {
  const { title = "Frequently asked questions", caption, items = [] } = props;

  return (
    <GalleryFrame caption={caption} title={title}>
      <div className="divide-y divide-border/60">
        {items.map((item) => (
          <div
            className="py-2.5 first:pt-0 last:pb-0"
            key={item.question}
          >
            <div className="flex items-baseline justify-between gap-2">
              <h5 className="font-semibold text-sm text-foreground">
                {item.question}
              </h5>
              {item.category ? <Badge>{item.category}</Badge> : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
              {item.answer}
            </p>
          </div>
        ))}
      </div>
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- GALLERY Export */

export const GALLERY: GalleryComponent[] = [
  {
    name: "showSchedule",
    title: "Schedule",
    kind: "card",
    description:
      "Display a day's schedule, calendar agenda, or event itinerary with time blocks, durations, and room or video links.",
    parameters: ScheduleProps,
    Component: ScheduleCard as GalleryComponent["Component"],
    preview: {
      title: "Today's Architecture Review",
      date: "Thursday, Oct 16",
      caption: "All times Eastern (UTC-4)",
      events: [
        {
          time: "09:30 AM",
          title: "Keynote & Service Vision",
          duration: "30m",
          location: "Main Hall / Zoom A",
          tag: "General",
        },
        {
          time: "10:15 AM",
          title: "API Gateway Migration",
          duration: "45m",
          location: "Room 402",
          tag: "Infra",
          tagTone: "positive",
        },
        {
          time: "11:30 AM",
          title: "Incident Response Drill",
          duration: "1h",
          location: "War Room",
          tag: "Security",
          tagTone: "caution",
        },
        {
          time: "02:00 PM",
          title: "Roadmap Wrap-up",
          duration: "30m",
          location: "Zoom A",
          tag: "Product",
        },
      ],
    },
    confirmation: "The schedule is now on screen for the person.",
  },
  {
    name: "showPersonProfile",
    title: "Contact card",
    kind: "card",
    description:
      "Show a team member's role, contact details, timezone, availability status, and areas of expertise.",
    parameters: PersonProfileProps,
    Component: PersonProfileCard as GalleryComponent["Component"],
    preview: {
      name: "Marcus Vance",
      role: "Staff Reliability Engineer",
      department: "Platform Infrastructure",
      email: "marcus.vance@remii.test",
      timezone: "PST (UTC-8)",
      status: "on_call",
      tags: ["Kubernetes", "PostgreSQL", "Kafka", "Disaster Recovery"],
    },
    confirmation: "The contact card is now on screen for the person.",
  },
  {
    name: "showKanban",
    title: "Kanban board",
    kind: "card",
    description:
      "Present a snapshot of tasks across sprint columns (To Do, In Progress, Done) with priorities and assignees.",
    parameters: KanbanProps,
    Component: KanbanCard as GalleryComponent["Component"],
    preview: {
      title: "Sprint 42: Edge Deployment",
      caption: "Target release: Friday EOD",
      columns: [
        {
          name: "To Do",
          cards: [
            {
              title: "Implement rate limiter on /api/v2",
              priority: "high",
              assignee: "Alex",
            },
            { title: "Update Terraform state locks", priority: "medium" },
          ],
        },
        {
          name: "In Progress",
          cards: [
            {
              title: "Dual-write validation test",
              priority: "high",
              assignee: "Priya",
            },
          ],
        },
        {
          name: "Done",
          cards: [
            {
              title: "Audit log retention migration",
              priority: "low",
              assignee: "Liam",
            },
            {
              title: "Upgrade Redis nodes to 7.4",
              priority: "medium",
              assignee: "Priya",
            },
          ],
        },
      ],
    },
    confirmation: "The kanban board is now on screen for the person.",
  },
  {
    name: "showFaq",
    title: "FAQ list",
    kind: "card",
    description:
      "Display answers to common questions, policy details, or troubleshooting steps in a categorized Q&A list.",
    parameters: FaqProps,
    Component: FaqCard as GalleryComponent["Component"],
    preview: {
      title: "Workspace Security Policy FAQ",
      caption: "Updated for Q4 compliance standards",
      items: [
        {
          question: "How are Bot credentials and tokens encrypted?",
          answer:
            "All integration tokens and API keys are encrypted at rest using AES-256-GCM with envelope encryption via AWS KMS.",
          category: "Encryption",
        },
        {
          question: "Can guest users interact with Sandboxed Bot components?",
          answer:
            "Only users granted channel access can trigger components, and destructive actions require explicit permission grants.",
          category: "Access",
        },
        {
          question: "How long are audit trails retained?",
          answer:
            "Deployment logs and tool execution history are stored for 90 days by default, or 1 year on Enterprise plans.",
          category: "Compliance",
        },
      ],
    },
    confirmation: "The FAQ list is now on screen for the person.",
  },
];
