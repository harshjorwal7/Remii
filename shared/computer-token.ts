import { createHmac } from "node:crypto";

/**
 * The token one computer answers to, derived from the deployment's own.
 *
 * Strict per-user SaaS sandbox: a single deployment-wide `COMPUTER_TOKEN`
 * handed to every computer means every computer can present the token every
 * other computer accepts. So one user's sandbox, with a shell, could call
 * another user's sandbox on its published port and drive their browser, read
 * their files and read their logins — with the one secret it was already
 * given, and nothing left to distinguish the two.
 *
 * HMAC is what closes that: the deployment secret stays with the server and
 * the supervisor, each computer is handed ONLY the token derived for its own
 * (user, Bot) key, and a computer cannot derive another computer's token
 * because it does not hold the key material. A leaked per-computer token
 * therefore opens exactly one computer — the one it was minted for.
 *
 * Deterministic on purpose: the server and the supervisor must agree on it
 * without storing a second secret anywhere, and a computer that restarts
 * keeps the token it was born with (its own `holdsCurrentToken` check sees
 * no mismatch, so an ordinary restart is not a replacement).
 */
export function computerInstanceToken(
  deploymentToken: string,
  computerKey: string,
): string {
  return createHmac("sha256", deploymentToken)
    .update(`remii-computer-instance\u0000${computerKey}`)
    .digest("base64url");
}

/**
 * The environment a per-instance computer is started with: its own token,
 * never the deployment's.
 *
 * A computer given the deployment secret could derive every other computer's
 * token, which is the whole leak this closes. It gets `COMPUTER_TOKEN` (its
 * own, which the existing computer service already reads) and
 * `COMPUTER_TOKEN_IS_INSTANCE=true`, which tells it that the value it holds
 * is an instance token rather than the deployment's, so an old shared
 * `agent-computer` in the same stack keeps accepting the deployment token it
 * was started with.
 */
export function computerInstanceEnvironment(
  deploymentToken: string,
  computerKey: string,
  environment: string[],
): string[] {
  const instanceToken = computerInstanceToken(deploymentToken, computerKey);
  return environment.flatMap((line) =>
    line.startsWith("COMPUTER_TOKEN=")
      ? [`COMPUTER_TOKEN=${instanceToken}`, "COMPUTER_TOKEN_IS_INSTANCE=true"]
      : [line],
  );
}

/**
 * A Bot's id, signed by the deployment secret.
 *
 * THE HEADER ALONE WAS AN IDENTITY NOBODY CHECKED. A call to a computer carries two things: the
 * shared `COMPUTER_TOKEN`, and `x-remii-bot-id` naming whose computer is being driven. The token is
 * verified; the Bot id was not, and the computer resolved the profile and the workspace from it
 * verbatim.
 *
 * With a container per Bot that is masked — the container only holds one Bot's data, so naming
 * another changes nothing. On ONE computer it stops being masked, because one process holds every
 * Bot's profile, workspace and logins. A caller holding the deployment token could then ask for
 * another Bot's profile by changing a header, which is another Bot's signed-in sessions.
 *
 * So the id is signed, and the computer checks the signature against the secret it already holds.
 * `computerKey` is the Bot id, not the (user, Bot) key: the computer has no way to know the owner,
 * and inventing a shared derivation the two sides could disagree about would be worse than signing
 * exactly the value that is being asserted.
 */
export function computerBotIdSignature(
  deploymentToken: string,
  botId: string,
): string {
  return createHmac("sha256", deploymentToken)
    .update(`remii-computer-bot-id\u0000${botId}`)
    .digest("base64url");
}
