import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import React, { useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ExecutionMode } from "@/components/settings/execution-mode";
import { ModelChoice } from "@/components/settings/model-choice";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { setComputerStateMutationOptions } from "@/lib/computers/mutations";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   *
   * Connected accounts used to be a section below. It is its own screen now: a connector can need
   * more from a person than one switch, and a section cannot grow a page's worth of that.
   */
  return (
    <PageShell
      description="How Remii looks and behaves for you. These apply to your account alone, on every deployment you sign in to."
      title="Preferences"
    >
      <PageSection title="General">
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Dark theme</ItemTitle>
              <ItemDescription>
                Use the dark appearance across Remii.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Dark theme"
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      {/*
       * Above the shortcuts and below the appearance switch, because it is the only thing on this
       * screen that changes what a coworker says rather than what this browser looks like.
       */}
      <StandingInstructions />
      {/*
       * Which model answers this person's turns: the deployment default (Space Flash) or the
       * abliterated model (Darkside). Above execution mode because it changes what a coworker
       * says, not just how it acts.
       */}
      <ModelChoice />
      {/*
       * Beside standing instructions: the other thing on this screen that changes what a
       * coworker does rather than what this browser looks like — whether it acts directly or
       * confirms external actions first.
       */}
      <ExecutionMode />
      <BrowserPrivacy />
      {/*
       * Drawn from the same registry the listeners match against, so this list is what the keys
       * actually do rather than what somebody remembered they did. Read-only on purpose: these
       * are not rebindable, and a row with nothing to click says so by having nothing to click.
       */}
      <PageSection title="Keyboard shortcuts">
        <PageRows>
          {HOTKEYS.map((hotkey, index) => (
            <React.Fragment key={hotkey.id}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{hotkey.label}</ItemTitle>
                  <ItemDescription>{hotkey.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="flex gap-1">
                    {formatHotkey(hotkey.combo).map((part) => (
                      <kbd
                        className="rounded-md border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground"
                        key={part}
                      >
                        {part}
                      </kbd>
                    ))}
                  </span>
                </ItemActions>
              </Item>
              {index !== HOTKEYS.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </PageRows>
      </PageSection>
    </PageShell>
  );
}

/**
 * Wipe a Bot's browser profile: cookies, history, logins.
 *
 * A reset deletes the sandbox (E2B) or the container and its profile
 * volume (Docker) while the user's disk — files, threads, credits — stays
 * untouched. Per Bot, because screens are per Bot: wiping one coworker's
 * logins must not sign every other coworker out.
 */
function BrowserPrivacy() {
  const { data: agents } = useQuery(agentListQueryOptions());
  const resetComputer = useMutation(
    setComputerStateMutationOptions(queryClient),
  );
  const [confirming, setConfirming] = useState<string | null>(null);

  const bots = (agents ?? []).filter(
    (agent) => !(agent as { isSystemTemplate?: boolean }).isSystemTemplate,
  );
  if (bots.length === 0) return null;

  return (
    <PageSection title="Browser & Privacy">
      <PageRows>
        {bots.map((bot, index) => (
          <React.Fragment key={bot.id}>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>{bot.name}</ItemTitle>
                <ItemDescription>
                  Clear this coworker&apos;s browser cookies, history, and saved
                  logins. Files and conversation history are kept.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {confirming === bot.id ? (
                  <span className="flex gap-2">
                    <Button
                      disabled={resetComputer.isPending}
                      onClick={() => {
                        resetComputer.mutate(
                          { botId: bot.id, action: "reset" },
                          { onSettled: () => setConfirming(null) },
                        );
                      }}
                      size="sm"
                      variant="destructive"
                    >
                      Confirm wipe
                    </Button>
                    <Button
                      onClick={() => setConfirming(null)}
                      size="sm"
                      variant="ghost"
                    >
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button
                    onClick={() => setConfirming(bot.id)}
                    size="sm"
                    variant="outline"
                  >
                    Clear browser data
                  </Button>
                )}
              </ItemActions>
            </Item>
            {index !== bots.length - 1 && <Separator />}
          </React.Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}
