import {
  IconAlertCircle,
  IconCalendar,
  IconClock,
  IconCode,
  IconRobot,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { relativeTime } from "@/lib/relative-time";
import {
  addScheduleMutationOptions,
  deleteScheduleMutationOptions,
  schedulesQueryOptions,
  updateScheduleMutationOptions,
} from "@/lib/remi";
import {
  buildCronExpression,
  DAYS_OF_WEEK,
  describeCron,
  FREQUENCY_OPTIONS,
  getLocalTimezone,
  type ScheduleFrequency,
} from "@/lib/schedules/cron-helper";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings/schedules")({
  component: RouteComponent,
});

/**
 * One fact about a schedule, worn as a small pill.
 */
function Chip({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Recurring work your Bot does on a schedule.
 *
 * Each job runs its prompt as the assigned Bot on its cron expression. Switching one off pauses it;
 * deleting it removes it. Ten failed firings in a row switch a job off automatically.
 */
function RouteComponent() {
  const queryClient = useQueryClient();
  const schedules = useQuery(schedulesQueryOptions());
  const agentsQuery = useQuery(agentListQueryOptions());
  const allAgents = agentsQuery.data ?? [];

  // Active coworkers in the workspace (including Remii / chief of staff), excluding blueprint templates
  const agents = useMemo(() => {
    return allAgents.filter((agent) => !agent.isSystemTemplate);
  }, [allAgents]);

  const defaultAgent = useMemo(() => {
    return defaultAgentProfile(agents);
  }, [agents]);

  const add = useMutation(addScheduleMutationOptions(queryClient));
  const update = useMutation(updateScheduleMutationOptions(queryClient));
  const remove = useMutation(deleteScheduleMutationOptions(queryClient));

  // Form State
  const [name, setName] = useState("");
  const [selectedBotId, setSelectedBotId] = useState<string>("");
  const [frequency, setFrequency] = useState<ScheduleFrequency>("weekdays");
  const [dayOfWeek, setDayOfWeek] = useState<number>(1);
  const [time, setTime] = useState("09:00");
  const [customCron, setCustomCron] = useState("0 9 * * 1-5");
  const [isCustomMode, setIsCustomMode] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const localTimezone = useMemo(() => getLocalTimezone(), []);

  // Compute the active cron expression from selections or custom input
  const computedExpression = useMemo(() => {
    return buildCronExpression({
      frequency: isCustomMode ? "custom" : frequency,
      time,
      dayOfWeek,
      customCron,
    });
  }, [isCustomMode, frequency, time, dayOfWeek, customCron]);

  // English description of current schedule builder state
  const cadenceDescription = useMemo(() => {
    return describeCron(computedExpression);
  }, [computedExpression]);

  // Agent lookup map for quick title/avatar resolution across all agents
  const agentMap = useMemo(() => {
    return new Map(allAgents.map((agent) => [agent.id, agent]));
  }, [allAgents]);

  // Default agent if none explicitly selected
  const activeAgent = selectedBotId
    ? agentMap.get(selectedBotId)
    : (defaultAgent ?? agents[0]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !computedExpression.trim() || !prompt.trim()) return;
    setError(null);

    add.mutate(
      {
        name: name.trim(),
        expression: computedExpression.trim(),
        botId: selectedBotId || activeAgent?.id,
        timezone: localTimezone,
        prompt: prompt.trim(),
      },
      {
        onSuccess: () => {
          setName("");
          setPrompt("");
          setError(null);
        },
        onError: (caught) => {
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not schedule that.",
          );
        },
      },
    );
  };

  return (
    <PageShell
      description="Recurring work your Bot does on its own, in your channels, as you."
      title="Schedules"
    >
      <PageSection title="New schedule">
        <form className="flex flex-col gap-3.5" onSubmit={handleSubmit}>
          {/* Schedule Name */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Schedule name
            </label>
            <Input
              aria-label="Schedule name"
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Daily Standup Briefing"
              value={name}
            />
          </div>

          {/* Assigned Agent - Only user's own agents */}
          {agents.length > 0 && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Assigned coworker
              </label>
              <Select
                value={selectedBotId || activeAgent?.id || ""}
                onValueChange={(val) => {
                  if (typeof val === "string") setSelectedBotId(val);
                }}
              >
                <SelectTrigger className="w-full justify-between">
                  {activeAgent ? (
                    <div className="flex items-center gap-2">
                      <AbstractAvatar
                        name={activeAgent.name}
                        seed={activeAgent.avatarSeed || activeAgent.id}
                        mascot={activeAgent.mascot}
                        size={18}
                      />
                      <span className="font-medium text-foreground">
                        {activeAgent.name}
                      </span>
                      {activeAgent.title && (
                        <span className="text-xs text-muted-foreground">
                          · {activeAgent.title}
                        </span>
                      )}
                    </div>
                  ) : (
                    <SelectValue placeholder="Choose a coworker" />
                  )}
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      <div className="flex items-center gap-2">
                        <AbstractAvatar
                          name={agent.name}
                          seed={agent.avatarSeed || agent.id}
                          mascot={agent.mascot}
                          size={18}
                        />
                        <span className="font-medium">{agent.name}</span>
                        {agent.title && (
                          <span className="text-xs text-muted-foreground">
                            · {agent.title}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Schedule Cadence Builder */}
          <div className="rounded-lg border border-border bg-muted/30 p-3.5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <IconCalendar className="size-4 text-muted-foreground" />
                Cadence & Frequency
              </span>
              {/* `variant="link"`, not a hand-rolled underline: the recipe already owns the link treatment,
                  and the hand-rolled version put a 14px glyph beside 12px type and had no focus
                  ring, so keyboard users could not see where they were. */}
              <Button
                className="h-auto p-0 text-xs text-muted-foreground"
                onClick={() => {
                  setIsCustomMode(!isCustomMode);
                  if (!isCustomMode) {
                    setCustomCron(computedExpression);
                  }
                }}
                type="button"
                variant="link"
              >
                <IconCode data-icon="inline-start" />
                {isCustomMode ? "Use visual builder" : "Custom cron expression"}
              </Button>
            </div>

            {!isCustomMode ? (
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                {/* Frequency selector */}
                <div
                  className={
                    frequency === "weekly"
                      ? "sm:col-span-6"
                      : frequency === "hourly"
                        ? "sm:col-span-12"
                        : "sm:col-span-8"
                  }
                >
                  <Select
                    value={frequency}
                    onValueChange={(val) => {
                      if (val) setFrequency(val as ScheduleFrequency);
                    }}
                  >
                    <SelectTrigger className="w-full h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FREQUENCY_OPTIONS.filter(
                        (opt) => opt.value !== "custom",
                      ).map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Day of Week selector for weekly */}
                {frequency === "weekly" && (
                  <div className="sm:col-span-3">
                    <Select
                      value={dayOfWeek.toString()}
                      onValueChange={(val) => {
                        if (val) setDayOfWeek(Number.parseInt(val, 10));
                      }}
                    >
                      <SelectTrigger className="w-full h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DAYS_OF_WEEK.map((day) => (
                          <SelectItem
                            key={day.value}
                            value={day.value.toString()}
                          >
                            {day.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Time selector (for non-hourly) */}
                {frequency !== "hourly" && (
                  <div
                    className={
                      frequency === "weekly" ? "sm:col-span-3" : "sm:col-span-4"
                    }
                  >
                    <Input
                      type="time"
                      aria-label="Execution time"
                      className="w-full h-9"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div>
                <Input
                  aria-label="Cron expression"
                  onChange={(event) => setCustomCron(event.target.value)}
                  placeholder="e.g. 0 9 * * 1-5"
                  value={customCron}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Standard 5-field cron format: minute hour day-of-month month
                  day-of-week
                </p>
              </div>
            )}

            {/* Live translation & preview */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/50 text-xs">
              <div className="flex items-center gap-1.5 text-foreground/90 font-medium">
                <span>{cadenceDescription}</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span className="font-mono text-[11px] bg-background/80 border border-border/60 px-1.5 py-0.5 rounded">
                  {computedExpression}
                </span>
                <span>· {localTimezone}</span>
              </div>
            </div>
          </div>

          {/* Prompt / Instruction */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              What should the Bot do each time?
            </label>
            <Textarea
              aria-label="What the Bot should do"
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="e.g. Summarize top pull requests and pending issues, then post a concise daily brief into our team channel."
              value={prompt}
              rows={3}
            />
          </div>

          <div>
            <Button
              disabled={
                add.isPending ||
                !name.trim() ||
                !computedExpression.trim() ||
                !prompt.trim()
              }
              type="submit"
            >
              {add.isPending ? "Scheduling…" : "Schedule"}
            </Button>
          </div>

          {error ? (
            <div
              className="flex items-center gap-2 text-destructive text-sm"
              role="alert"
            >
              <IconAlertCircle className="size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </form>
      </PageSection>

      <PageSection title="Active schedules">
        {schedules.isPending ? null : schedules.isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Schedules could not be loaded. Reload the page.
          </p>
        ) : (schedules.data?.schedules ?? []).length === 0 ? (
          <PageEmpty>
            Nothing scheduled yet. Set up a schedule above to let your Bot
            handle recurring tasks.
          </PageEmpty>
        ) : (
          <PageRows>
            {(schedules.data?.schedules ?? []).map((job) => {
              const assignedAgent = job.botId
                ? agentMap.get(job.botId)
                : undefined;
              const formattedNextRun = job.nextRunAt
                ? relativeTime(job.nextRunAt)
                : null;

              return (
                <Item key={job.id} variant="muted">
                  <ItemContent className={job.enabled ? "" : "opacity-60"}>
                    <ItemTitle className="font-medium text-sm flex items-center gap-2">
                      {job.name}
                    </ItemTitle>
                    {job.prompt && (
                      <ItemDescription className="line-clamp-2 text-xs">
                        {job.prompt}
                      </ItemDescription>
                    )}
                    <ItemFooter className="mt-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {/* Assigned Bot Chip */}
                        {assignedAgent ? (
                          <Chip className="bg-background text-foreground font-medium">
                            <AbstractAvatar
                              name={assignedAgent.name}
                              seed={
                                assignedAgent.avatarSeed || assignedAgent.id
                              }
                              mascot={assignedAgent.mascot}
                              size={14}
                            />
                            {assignedAgent.name}
                          </Chip>
                        ) : job.botId ? (
                          <Chip>
                            <IconRobot className="size-3" />
                            {job.botId}
                          </Chip>
                        ) : (
                          <Chip>
                            <IconRobot className="size-3" />
                            General Assistant
                          </Chip>
                        )}

                        {/* Cadence description Chip */}
                        <Chip>
                          <IconClock className="size-3" />
                          {describeCron(job.expression)}
                        </Chip>

                        {/* Next run Chip */}
                        {job.enabled && job.nextRunAt ? (
                          <Chip>Next: {formattedNextRun}</Chip>
                        ) : null}

                        {/* Paused state */}
                        {!job.enabled ? (
                          <Chip className="text-muted-foreground">Paused</Chip>
                        ) : null}

                        {/* Error state */}
                        {job.lastError ? (
                          <Chip className="border-destructive/40 text-destructive">
                            <span className="size-1.5 rounded-full bg-destructive" />
                            Failed: {job.lastError}
                          </Chip>
                        ) : null}
                      </div>
                    </ItemFooter>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={job.enabled ? "Switch off" : "Switch on"}
                      checked={job.enabled}
                      disabled={update.isPending}
                      onCheckedChange={(checked) =>
                        update.mutate({ id: job.id, enabled: checked })
                      }
                    />
                    <Button
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(job.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Delete
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
