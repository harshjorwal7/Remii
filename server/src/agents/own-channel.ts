import type { AgentActor } from "../agents/profile-types";
import type { AgentChannel } from "../channels/routes";

/**
 * The two ids a delegation into a coworker's own conversation needs, named.
 *
 * A CHANNEL and its THREAD are different things that look alike, and a hop needs both: it runs in
 * the thread, and it is read as a channel. Passing one value for both is not a typo that shows up
 * as a type error — it type-checks perfectly, it stores, it signs, and the whole hop completes. What
 * it breaks is only visible to the person: the work runs in a thread invented on the spot and named
 * after the channel, so the coworker's real conversation stays empty and the answer looks like
 * nothing happened.
 *
 * THAT IS NOT HYPOTHETICAL. `ownThreadFor` in `index.ts` returned `channel.id` where the delivery
 * wanted a thread, for as long as delegation into an own channel had existed. Coco's channel sat
 * empty in the sidebar, the email draft existed, and Coco had asked the person a question that was
 * nowhere they could answer it.
 *
 * So the mapping is a function of the WHOLE channel, and there is no longer a place where a caller
 * picks one field out of a channel and hands it on as something else. Passing the channel is the
 * only way in, and a channel that somehow had one id for both would be caught by the type rather
 * than by a person noticing an empty screen.
 */
export type OwnChannel = {
  /** What a roster row is, and what a link is. */
  channelId: string;
  /** What a run happens in, and what a transcript is. */
  threadId: string;
};

export function ownChannelFor(channel: AgentChannel): OwnChannel {
  return {
    channelId: channel.id,
    threadId: channel.threadId,
  };
}

/**
 * The coworker's own conversation with this person, made if they have not had one.
 *
 * `direct` rather than `create`, because a hop is retried when delivery fails and a plain create
 * would leave an empty conversation behind for every attempt.
 *
 * RESOLVED FROM THE PERSON AND THE BOT, never from anything the model supplied, so a hop can only
 * ever land in a conversation those two already share. Returns null rather than throwing on a person
 * who cannot be resolved, because the caller's answer to that is a refusal with a sentence and a
 * thrown error ends the run in silence.
 */
export async function resolveOwnChannel(
  actorId: string,
  botId: string,
  find: (actor: AgentActor, botId: string) => Promise<AgentChannel | null>,
  actorFor: (userId: string) => Promise<AgentActor | null>,
): Promise<OwnChannel | null> {
  const actor = await actorFor(actorId).catch(() => null);
  if (!actor) return null;
  const channel = await find(actor, botId);
  if (!channel) return null;
  return ownChannelFor(channel);
}
