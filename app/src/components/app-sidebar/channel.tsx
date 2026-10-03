import {
  IconDots,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { REMII_AGENT_ID } from "@/lib/agents/default-agent";
import {
  deleteChannelMutationOptions,
  setChannelPinnedMutationOptions,
} from "@/lib/channels/mutations";
import type { ChannelActivityBrief } from "@/lib/channels/queries";
import { useTypedReveal } from "@/lib/typed-reveal";
import type { MascotChoice } from "../../../../shared/mascot-ids";
import { ActivityMark, aiStateForChannel } from "../channels/activity-mark";
import { ChannelAvatar } from "../channels/avatar";

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 *
 * Right-click opens Pin and Delete. Deleting is confirmed in a dialog that names the channel,
 * because the row it was invoked on is one of several identical-looking rows.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  mascots,
  name,
  summary,
  lastMessage,
  lastMessageAt,
  pinned,
  unread,
  busy,
  activity,
}: {
  channelId: string;
  participantIds: string[];
  /**
   * The chosen mascot of each participant, by id. Threaded straight from the roster query so the row
   * can draw the same face the profile screen does without fetching anything of its own.
   */
  mascots?: Record<string, Partial<MascotChoice>>;
  name: string;
  /** What the conversation is about, once named. The channel name only says which Bot it is. */
  summary?: string;
  /** Shown on that same line until the conversation has been named. */
  lastMessage?: string;
  lastMessageAt?: string;
  pinned: boolean;
  unread: boolean;
  busy: boolean;
  /** What is running in this channel, or null. See `ChannelSummary.activity`. */
  activity?: ChannelActivityBrief | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Whether this row's channel is the one on screen, as a boolean, so navigating between
  // channels re-renders the two rows whose answer changed rather than the whole roster.
  const isOpen = useParams({
    strict: false,
    select: (params) =>
      (params as { channelId?: string }).channelId === channelId,
  });
  /* Types in only on arrival; an already-named row draws it outright. */
  const revealed = useTypedReveal(summary);
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const agentId = participantIds[0];
  /**
   * What this row's avatar is doing, keyed by the participant it belongs to.
   *
   * The brief names the Bot that is running (`botId`), and that is the only participant whose mascot
   * may wear the work state — the others in a stacked row are in the channel, not doing anything in it,
   * and animating them all would have a row of three working when one is. `botId` is matched rather
   * than assumed to be the first participant because the roster does not guarantee the order, and an
   * avatar that reacts on the wrong face is worse than one that never reacts.
   *
   * Memoised on the three inputs rather than rebuilt inline: a fresh object every render is a changed
   * prop on every render, which would defeat the memo on `ChannelAvatar` and re-run the whole avatar
   * on every socket event in any channel.
   */
  const avatarStates = useMemo(() => {
    const state = aiStateForChannel(activity, busy);
    const botId = activity?.botId;
    if (!state || state === "idle" || !botId) return undefined;
    return { [botId]: state };
  }, [activity, busy]);
  /**
   * Why a pin did not take, said on the row it was asked of.
   *
   * Pinning used to fail in total silence: the menu closed, the pin did not move, and nothing on
   * screen accounted for it — which reads as the app ignoring the click. There is no toast in this
   * app, and the row is where the person was looking, so the sentence goes here and is replaced by
   * the next attempt.
   */
  const [pinProblem, setPinProblem] = useState<string | null>(null);

  const confirmDelete = async () => {
    /*
     * Away first when this row's channel is the one on screen.
     *
     * The roster invalidates the moment the delete lands, so this row — and the dialog living inside
     * it — unmounts while the rest of this function is still owed. Navigating after the mutation
     * therefore ran in a component that was already gone, leaving somebody looking at a conversation
     * that no longer exists. Leaving before asking is safe in the other direction: a refused delete
     * puts them on the roster with the channel still in it, and says why in the dialog.
     */
    if (isOpen) {
      await navigate({ to: "/" });
    }
    try {
      await deleteChannel.mutateAsync(channelId);
    } catch {
      // The error is on the mutation and rendered in the dialog; leaving it open says "not done".
      return;
    }
    setConfirming(false);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            to="/channel/$channelId"
            params={{ channelId }}
            type="button"
            className="flex flex-row py-2 px-2 gap-2 items-center w-full hover:bg-foreground/5 rounded-lg [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
            activeProps={{
              className: "bg-foreground/5",
            }}
          >
            {/*
             * 36px, not 32. The row is `3.25rem` with `py-2`, so 36 is exactly what it has to give
             * without the row growing — the whole increase is free in layout terms.
             *
             * It matters because the roster is where a mascot is hardest to draw. At 32px the body came
             * out about 25px across and the two eye-holes about two, and at that ratio the rasteriser
             * has so little to work with that the face softens into a smudge: the row reads as having a
             * grey blob in it rather than a coworker. Twelve per cent more width is twelve per cent
             * more pixels on the eyes, and the eyes are what make it a face.
             */}
            <div className="shrink-0">
              <ChannelAvatar
                participantIds={participantIds}
                mascots={mascots}
                size={36}
                typing={busy}
                states={avatarStates}
              />
            </div>
            <div className="flex-col min-w-0 flex-1">
              <div className="flex flex-row items-center justify-between gap-2">
                <span
                  className={`text-[14px] tracking-[-1%] truncate ${
                    unread ? "font-medium" : ""
                  }`}
                >
                  {name}
                </span>
                {/*
                 * The chief of staff reads apart from every other row. Remii is the default
                 * coworker, holds the whole of the person's powers, and is always present — a
                 * badge states that where the person looks, rather than in a profile they may
                 * never open. Matched on the stable agent id, not the display name.
                 */}
                {participantIds.includes(REMII_AGENT_ID) ? (
                  <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-semibold tracking-wide text-primary uppercase">
                    CoS
                  </span>
                ) : null}
                <div className="text-[12px] text-muted-foreground/70">
                  {lastMessageAt}
                </div>
              </div>
              <div className="mt-px flex h-4 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
                  {/* Falls back to the last message, so the line never blanks while naming runs. */}
                  {revealed.text ?? lastMessage}
                  {revealed.typing ? (
                    /* Solid, not blinking: this is over in under half a second. */
                    <span className="ml-0.5 inline-block h-3 w-px translate-y-px bg-muted-foreground/70 align-middle" />
                  ) : null}
                </span>
                {/*
                 * What is RUNNING, above whether there is something unread.
                 *
                 * Unread is a fact about the past and a running run is a fact about now, and a
                 * person opening a roster is asking what is happening before they are asking what
                 * they missed. The mark goes first for the same reason the unread dot does — state
                 * about the run beats decoration.
                 */}
                {activity ? <ActivityMark activity={activity} /> : null}
                {unread ? (
                  /* State about the message beats state about the row, so it sits first. */
                  <span className="size-2 shrink-0 rounded-full bg-primary" />
                ) : null}
                {pinned ? (
                  <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" />
                ) : null}
                {/*
                 * `-my-1` because this sits in a `h-4` row: the primitive's 24px hit area would
                 * otherwise stretch the row and add a line to every channel in the roster. The
                 * negative margin pulls the box back to 20px around a 12px glyph, which is a target
                 * a thumb can hit without the list growing.
                 */}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        aria-label="Channel options"
                        className="-my-1 shrink-0 text-muted-foreground/70 hover:text-foreground"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      >
                        <IconDots />
                      </Button>
                    }
                  />
                  <DropdownMenuContent
                    align="end"
                    side="bottom"
                    className="w-auto min-w-36 whitespace-nowrap"
                  >
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        setPinProblem(null);
                        setPinned.mutate(
                          { channelId, pinned: !pinned },
                          {
                            onError: (thrown) => setPinProblem(thrown.message),
                          },
                        );
                      }}
                    >
                      {pinned ? <IconPinnedOff /> : <IconPin />}
                      {pinned ? "Unpin channel" : "Pin channel"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        if (agentId) {
                          setShowAgentSettings(true);
                        } else {
                          void navigate({ to: "/settings" });
                        }
                      }}
                    >
                      <IconSettings />
                      Settings
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteChannel.reset();
                        setConfirming(true);
                      }}
                    >
                      <IconTrash />
                      Delete channel…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              setPinProblem(null);
              setPinned.mutate(
                { channelId, pinned: !pinned },
                { onError: (thrown) => setPinProblem(thrown.message) },
              );
            }}
          >
            {pinned ? <IconPinnedOff /> : <IconPin />}
            {pinned ? "Unpin channel" : "Pin channel"}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              if (agentId) {
                setShowAgentSettings(true);
              } else {
                void navigate({ to: "/settings" });
              }
            }}
          >
            <IconSettings />
            Settings
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => {
              // A refusal from a previous attempt is not news about this one.
              deleteChannel.reset();
              setConfirming(true);
            }}
          >
            <IconTrash />
            Delete channel…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pinProblem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {pinProblem}
        </p>
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        open={confirming}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              The conversation will no longer appear for anyone in it.
            </DialogDescription>
          </DialogHeader>
          {deleteChannel.error ? (
            <p className="text-destructive text-sm">
              {deleteChannel.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={deleteChannel.isPending}
              onClick={() => {
                void confirmDelete();
              }}
              size="sm"
              variant="destructive"
            >
              {deleteChannel.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {agentId ? (
        <AgentDialog
          agentId={agentId}
          onClose={() => setShowAgentSettings(false)}
          open={showAgentSettings}
        />
      ) : null}
    </>
  );
});
