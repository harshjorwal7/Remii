import type { Message } from "@ag-ui/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { canSend, type Recipient } from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { duplicateAgentMutationOptions } from "@/lib/agents/mutations";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { workspaceAgentId } from "@/lib/agents/workspace";
import { useStartChannel } from "@/lib/channels/start";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { queryClient } from "@/query-client";
import { newId } from "../../../../lib/new-id";

/**
 * Creates the channel on first send. The selected coworker stays in the URL so profile links and
 * reloads preserve the pending recipient without creating an empty channel.
 */
export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { startChosen, pending } = useStartChannel();
  const { data: profiles, isError: rosterError } = useQuery(
    agentListQueryOptions(),
  );

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);
  /*
   * Templates join the workspace as copies, not as themselves. Picking a template and pressing
   * send duplicates it first and starts the channel with the copy, so the shared template is
   * never edited in place and never holds anybody's conversation. The duplication waits for the
   * first send the way channel creation does: choosing is free, sending commits.
   */
  const duplicate = useMutation(duplicateAgentMutationOptions(queryClient));
  const duplicateAsync = duplicate.mutateAsync;

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const {
    data: fetched,
    isError: detailError,
    isPending: detailPending,
  } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && profiles !== undefined && !listed,
    retry: false,
  });
  const chosen =
    listed ??
    (fetched?.id === agent ? fetched : undefined) ??
    (agent ? undefined : defaultAgentProfile(profiles));
  const needsUrlAgentDetail =
    Boolean(agent) && profiles !== undefined && !listed;
  const waitingForUrlAgent =
    needsUrlAgentDetail && detailPending && !detailError;
  const urlAgentDetailFailed = needsUrlAgentDetail && detailError && !fetched;
  const loadError =
    rosterError && profiles === undefined
      ? "Coworkers couldn't be loaded."
      : urlAgentDetailFailed
        ? "Coworker couldn't be loaded."
        : null;
  const recipients: Recipient[] = chosen
    ? [{ id: chosen.id, name: chosen.name }]
    : [];
  const skillCommands = useSkillCommands(chosen?.id ?? "");

  if (profiles === undefined && !rosterError) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="h-12 border-b border-border sticky top-0 flex flex-row px-2 items-center">
        <SidebarToggle className="mr-1" />
        <span className="text-sm text-muted-foreground">To:</span>
        <Combobox
          // Do not auto-open when the recipient came from the URL; the field is already answered.
          defaultOpen={!chosen && !loadError && !waitingForUrlAgent}
          autoHighlight
          items={(profiles ?? []).filter((item) => !item.isSystemTemplate)}
          isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
            item.id === value.id
          }
          itemToStringLabel={(item: AgentProfile) => item.name}
          itemToStringValue={(item: AgentProfile) => item.id}
          onValueChange={(next) => {
            // Recipient changes are not separate navigation history entries.
            void navigate({
              replace: true,
              search: next ? { agent: next.id } : {},
            });
          }}
          value={chosen ?? null}
        >
          <ComboboxInput
            // The popup opening is not enough on its own: typing filters through this input, so
            // the caret starts here whenever the recipient question is still open. Same condition
            // as `defaultOpen` — a recipient from the URL means the composer takes focus instead.
            autoFocus={!chosen}
            placeholder="Choose a coworker…"
            // InputGroup owns focus rings via `has-[…:focus-visible]`; disable that wrapper ring here.
            className="border-none w-full bg-transparent! text-sm has-[[data-slot=input-group-control]:focus-visible]:ring-0"
          />
          {/* Allow max-w to constrain the popup even though its anchor is full-width. */}
          <ComboboxContent className="min-w-0 max-w-lg" sideOffset={12}>
            <ComboboxEmpty>No agents found.</ComboboxEmpty>
            <ComboboxList>
              {(item: AgentProfile) => (
                <ComboboxItem key={item.id} value={item} className="h-10">
                  {/* The combobox has the whole profile in hand, so it shows the chosen mascot rather
                      than a seeded one that would differ from the card this same agent appears on. */}
                  <ChannelAvatar
                    participantIds={[item.id]}
                    mascots={
                      item.mascot ? { [item.id]: item.mascot } : undefined
                    }
                    size={24}
                  />
                  {item.name}
                  <span className="truncate text-muted-foreground ml-1">
                    {item.title}
                  </span>
                  {item.isSystemTemplate ? (
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      Template
                    </span>
                  ) : null}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <ConversationView
        // Choosing a coworker answers the "To:" field, so the message is what remains: the caret
        // lands in the composer the moment a recipient exists, whether picked here or in the URL.
        autoFocus
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        disabled={
          Boolean(loadError) || waitingForUrlAgent || recipients.length === 0
        }
        messages={sent ? [sent] : []}
        notice={
          loadError || error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {loadError ?? error}
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          const recipient = recipients[0];
          if (!recipient || !canSend(recipients, draft.text)) return;

          setError(null);
          setSent(seedMessage(draft.text, newId()));

          try {
            /*
             * A template is added to the workspace at the moment it is first spoken to: the
             * duplicate lands on the person's roster and the channel opens with the copy. A
             * duplicate that fails is a send that fails, with the draft preserved below.
             */
            const targetId = await workspaceAgentId(
              chosen?.id === recipient.id ? chosen : undefined,
              recipient.id,
              duplicateAsync,
            );
            // Recorded, then started: a coworker picked here is as much a choice as an `@` on the
            // home screen, and the trail has to say so for both.
            await startChosen(targetId, draft.text);
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error
                ? caught.message
                : "Could not start the conversation.",
            );
            throw caught;
          }
        }}
        pending={pending || duplicate.isPending}
      />
    </div>
  );
}
