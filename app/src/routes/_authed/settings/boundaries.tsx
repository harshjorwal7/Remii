import { IconAlertCircle, IconCheck, IconLock } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { billingQueryOptions } from "@/lib/billing/queries";
import { isComposing } from "@/lib/composing";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  type DryRunReport,
  dryRunActionPolicy,
} from "@/lib/computers/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * Plain-language switches backed by the exact same rules the gateway
 * enforces. The person never sees the rule text; the toggle writes it.
 */
const SWITCHES: { label: string; description: string; rule: string }[] = [
  {
    label: "Never submit forms",
    description:
      "Bots can fill in forms but can't press Submit or hit Enter to send one.",
    rule: '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && key == "Enter")',
  },
  {
    label: "Never type passwords",
    description:
      "Bots can't type into anything labeled password or secret. You take the wheel for logins instead.",
    rule: 'intent == "type" && contains(element.name, "password")',
  },
  {
    label: "Stay off social media",
    description: "Bots won't open Facebook, X, or other social networks.",
    rule: 'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com") || contains(page.host, "instagram.com") || contains(page.host, "tiktok.com"))',
  },
];

export const Route = createFileRoute("/_authed/settings/boundaries")({
  component: SettingsBoundariesPage,
});

function SettingsBoundariesPage() {
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [tested, setTested] = useState<{
    rule: string;
    report: DryRunReport;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const {
    data: billing,
    isPending: billingPending,
    isError: billingFailed,
  } = useQuery(billingQueryOptions());
  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));

  /*
   * THE PAID TIERS ARE NAMED ONCE, AND A FAILED READ GRANTS NOTHING.
   *
   * `tier` defaulted to "free" while the query was in flight AND permanently if it failed, so a
   * paying person's own boundaries were locked behind "Upgrade to Pro" during every reload and
   * after any billing outage — the same failure the Billing screen had, seen here as a paywall in
   * front of settings the account already owns.
   *
   * So the gate is three-valued, not two: while we do not know, we do not know. Refusing a switch
   * because a read failed is the server's decision to make, not a guess made in the browser, and
   * the save path enforces the tier again regardless.
   *
   * `starter` counts as paid here because the Billing screen has always counted it; the two pages
   * disagreed, and the one that disagreed in the direction of asking for money was this one.
   */
  const tier = billing?.subscription?.tier ?? null;
  const hasCustomPolicyAccess =
    tier === "pro" || tier === "power" || tier === "starter";
  /** Nothing is said about the tier until the read has actually answered. */
  const tierKnown = !billingPending && !billingFailed;

  const policy = savePolicy.data ?? stored.data ?? null;
  const saving = savePolicy.isPending;

  const save = (next: ActionPolicy) => {
    if (!hasCustomPolicyAccess) return;
    setSaved(false);
    setProblem(null);
    savePolicy.mutate(next, {
      onError: (thrown: Error) => setProblem(thrown.message),
      onSuccess: () => setSaved(true),
    });
  };

  const setRule = (rule: string, on: boolean) => {
    if (!hasCustomPolicyAccess || !policy) return;
    const deny = on
      ? policy.deny.includes(rule)
        ? policy.deny
        : [...policy.deny, rule]
      : policy.deny.filter((one) => one !== rule);
    void save({ ...policy, deny });
    setTested(null);
  };

  const addRule = (raw: string) => {
    if (!hasCustomPolicyAccess) return;
    if (!policy) return;
    const trimmed = raw.trim();
    if (!trimmed || policy.deny.includes(trimmed)) return;
    void save({ ...policy, deny: [...policy.deny, trimmed] });
    setDraft("");
    setTested(null);
  };

  const testRule = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || !policy) return;
    setProblem(null);
    setTesting(true);
    try {
      const report = await dryRunActionPolicy({
        ...policy,
        deny: [...policy.deny, trimmed],
      });
      setTested({ rule: trimmed, report });
    } catch (thrown) {
      setProblem((thrown as Error).message);
    } finally {
      setTesting(false);
    }
  };

  if (problem && !policy) {
    return (
      <PageShell title="What your bots may do">
        <p className="mt-4 text-destructive text-sm" role="alert">
          {problem}
        </p>
      </PageShell>
    );
  }

  if (stored.isError && !policy) {
    return (
      <PageShell title="What your bots may do">
        <p className="mt-4 text-sm text-muted-foreground" role="alert">
          Boundaries could not be loaded
          {stored.error instanceof Error ? `: ${stored.error.message}` : "."}{" "}
          The computer feature may not be configured on this deployment.
        </p>
      </PageShell>
    );
  }

  if (!policy) {
    return (
      <PageShell title="What your bots may do">
        <p className="mt-4 text-muted-foreground text-sm">Loading…</p>
      </PageShell>
    );
  }

  const knownRules = new Set(SWITCHES.map((item) => item.rule));
  const customRules = policy.deny.filter((rule) => !knownRules.has(rule));

  return (
    <PageShell
      description="Decide what your bots are never allowed to do on their computer."
      title="What your bots may do"
    >
      {/*
       * The paywall is for a tier we KNOW. A read that failed says nothing about what this person
       * pays for, and asking them to upgrade on the strength of a timeout is both wrong and a way
       * to lose a customer's trust for a five-second outage.
       */}
      {tierKnown && !hasCustomPolicyAccess ? (
        <div className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/10 p-4">
          <div className="flex items-start gap-3">
            <IconAlertCircle className="mt-0.5 size-5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm">
                Protected by the platform default
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Your bots run under shared safety rules. Upgrade to{" "}
                <strong>Pro</strong> to switch on your own limits below.
              </p>
              <div className="mt-3">
                <Button
                  render={<Link to="/settings/billing">Upgrade to Pro</Link>}
                  size="sm"
                  variant="default"
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-6 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3.5">
          <IconCheck className="size-4 text-emerald-500" />
          <span className="text-sm font-medium text-foreground">
            Your limits apply automatically to everything your bots do.
          </span>
        </div>
      )}

      <PageSection
        description="Flip a switch and the matching actions stop — or get recorded, if you prefer to just watch."
        title="Limits"
      >
        <div className="mt-2 divide-y divide-border rounded-md border border-border">
          {SWITCHES.map((item) => {
            const on = policy.deny.includes(item.rule);
            return (
              <div
                className="flex items-center justify-between gap-4 px-4 py-3"
                key={item.label}
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm text-foreground">
                    {item.label}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.description}
                  </p>
                </div>
                <Switch
                  aria-label={item.label}
                  checked={on}
                  disabled={saving || !tierKnown || !hasCustomPolicyAccess}
                  onCheckedChange={(checked) => setRule(item.rule, checked)}
                />
              </div>
            );
          })}
        </div>

        {customRules.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {customRules.length === 1
                ? "1 advanced rule"
                : `${customRules.length} advanced rules`}
            </p>
            <ul className="mt-2 divide-y divide-border rounded-md border border-border">
              {customRules.map((rule) => (
                <li
                  className="flex items-center justify-between gap-4 px-3 py-2"
                  key={rule}
                >
                  <code className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                    {rule}
                  </code>
                  {tierKnown && hasCustomPolicyAccess && (
                    <Button
                      disabled={saving}
                      onClick={() =>
                        void save({
                          ...policy,
                          deny: policy.deny.filter((one) => one !== rule),
                        })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {hasCustomPolicyAccess ? (
          <div className="mt-4">
            <button
              className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => setShowAdvanced((value) => !value)}
              type="button"
            >
              {showAdvanced
                ? "Hide advanced rule writer"
                : "Write your own rule (advanced)"}
            </button>
            {showAdvanced && (
              <div className="mt-3">
                <div className="flex gap-2">
                  <Input
                    aria-label="Describe what to block, in the bot's own rule language"
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="min-w-0 flex-1 font-mono text-xs"
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setSaved(false);
                      setTested(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !isComposing(event))
                        addRule(draft);
                    }}
                    placeholder="What should your bots never do?"
                    spellCheck={false}
                    value={draft}
                  />
                  <Button
                    disabled={testing || draft.trim().length === 0}
                    onClick={() => void testRule(draft)}
                    size="sm"
                    variant="outline"
                  >
                    {testing ? "Checking…" : "Check first"}
                  </Button>
                  <Button
                    disabled={saving || draft.trim().length === 0}
                    onClick={() => addRule(draft)}
                    size="sm"
                  >
                    Add
                  </Button>
                </div>
                {tested ? <DryRunResult report={tested.report} /> : null}
              </div>
            )}
          </div>
        ) : null}
      </PageSection>

      <PageSection
        description="Stopped means the bot is blocked and told why. Recorded means it goes ahead and the attempt is logged."
        title="When a limit hits"
      >
        <div className="mt-2 flex gap-2">
          <Button
            aria-pressed={policy.mode === "enforce"}
            className={cn(
              policy.mode === "enforce" ? "bg-foreground/5" : undefined,
            )}
            disabled={saving || !hasCustomPolicyAccess}
            onClick={() => void save({ ...policy, mode: "enforce" })}
            size="sm"
            variant="outline"
          >
            {!hasCustomPolicyAccess && (
              <IconLock className="opacity-60" data-icon="inline-start" />
            )}
            Stop the action
          </Button>
          <Button
            aria-pressed={policy.mode === "dry-run"}
            className={cn(
              policy.mode === "dry-run" ? "bg-foreground/5" : undefined,
            )}
            disabled={saving || !hasCustomPolicyAccess}
            onClick={() => void save({ ...policy, mode: "dry-run" })}
            size="sm"
            variant="outline"
          >
            {!hasCustomPolicyAccess && (
              <IconLock className="opacity-60" data-icon="inline-start" />
            )}
            Just record it
          </Button>
        </div>
      </PageSection>

      <p className="mt-8 text-muted-foreground text-xs">
        {problem ? (
          <span className="text-destructive" role="alert">
            {problem}
          </span>
        ) : saved ? (
          "Saved. Applies to the next thing your bots do."
        ) : hasCustomPolicyAccess ? (
          "Changes apply to the next thing your bots do, and are kept."
        ) : (
          "Upgrade to Pro in Billing to switch on your own limits."
        )}
      </p>
    </PageShell>
  );
}

function DryRunResult({ report }: { report: DryRunReport }) {
  if (report.scanned === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        No bot activity recorded yet, so there is nothing to check against.
      </p>
    );
  }

  return (
    <div className="mt-2" role="status">
      <p className="text-xs text-muted-foreground">
        {report.wouldRefuse === 0
          ? `Looked at your last ${report.scanned} bot actions: this rule would have blocked none of them.`
          : `Looked at your last ${report.scanned} bot actions: this rule would have blocked ${report.wouldRefuse}.`}
      </p>
      {report.changes.length > 0 ? (
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {report.changes.map((change) => (
            <li className="px-3 py-2" key={change.id}>
              <p className="text-xs">
                <span className="font-medium">
                  {change.would === "refused" ? "Would block" : "Would allow"}
                </span>{" "}
                <code className="font-mono">{change.action}</code>
                {change.element?.name ? <> on “{change.element.name}”</> : null}
                {change.command ? (
                  <>
                    {" "}
                    running <code className="font-mono">{change.command}</code>
                  </>
                ) : null}
                {change.file ? <> touching {change.file}</> : null}
              </p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {change.bot}
                {change.page ? <> · {change.page}</> : null} ·{" "}
                {new Date(change.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
