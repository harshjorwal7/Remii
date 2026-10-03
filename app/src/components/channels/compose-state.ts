/**
 * The rules a compose screen follows before there is a channel to hold them.
 *
 * Pure helpers so recipient-cap and sendability behavior stay testable without rendering.
 */

import type { MascotChoice } from "../../../../shared/mascot-ids";

export type Recipient = {
  id: string;
  name: string;
  /**
   * The coworker's chosen mascot, carried so the chip can draw the same face as the card the person
   * picked it from. Absent or null seeds from the id, which is what an undressed coworker gets
   * everywhere else — see `mergeMascotChoice`.
   */
  mascot?: Partial<MascotChoice> | null;
};

/**
 * One coworker per channel.
 *
 * Matches the chat screen's current one-coworker render contract.
 */
export const MAX_RECIPIENTS = 1;

/** Add a coworker, replacing the oldest once the channel recipient cap is reached. */
export function addRecipient(
  current: readonly Recipient[],
  next: Recipient,
): Recipient[] {
  if (current.some((recipient) => recipient.id === next.id)) {
    return [...current];
  }
  return [...current, next].slice(-MAX_RECIPIENTS);
}

export function removeRecipient(
  current: readonly Recipient[],
  id: string,
): Recipient[] {
  return current.filter((recipient) => recipient.id !== id);
}

/** Whether this draft can start a channel. */
export function canSend(
  recipients: readonly Recipient[],
  text: string,
): boolean {
  return recipients.length === MAX_RECIPIENTS && text.trim().length > 0;
}
