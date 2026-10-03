import { describe, expect, test } from "bun:test";
import {
  computerBotIdSignature,
  computerInstanceEnvironment,
  computerInstanceToken,
} from "./computer-token";

/**
 * One token per (user, Bot) computer, derived from the deployment's own.
 *
 * The leak this closes: a single deployment-wide `COMPUTER_TOKEN` handed to
 * every computer means every computer holds the token every other computer
 * accepts. With containers publishing loopback ports, one user's sandbox —
 * which runs what a Bot asks for, and a Bot has a shell — could call another
 * user's computer and drive their browser, read their files and read their
 * logins, using the one secret it was already given.
 */

describe("the per-computer token", () => {
  test("is deterministic, so the server and the supervisor agree without storing it", () => {
    expect(computerInstanceToken("secret", "computer-a")).toBe(
      computerInstanceToken("secret", "computer-a"),
    );
  });

  test("differs per computer and per deployment secret", () => {
    const a = computerInstanceToken("secret", "computer-a");
    const b = computerInstanceToken("secret", "computer-b");
    expect(a).not.toBe(b);
    expect(a).not.toBe(computerInstanceToken("other-secret", "computer-a"));
  });

  test("cannot be shortened or altered into another computer's token", () => {
    const a = computerInstanceToken("secret", "computer-a");
    expect(computerInstanceToken("secret", "computer-a ")).not.toBe(a);
    expect(computerInstanceToken("secret", "computer-aa")).not.toBe(a);
  });

  test("the computer's environment carries its own token and not the deployment's", () => {
    const key = "u_user-1__b_sales__abc123";
    const environment = computerInstanceEnvironment("deployment-secret", key, [
      `COMPUTER_BOT_ID=${key}`,
      "COMPUTER_TOKEN=deployment-secret",
      "COMPUTER_BROWSER_MODE=headless",
    ]);

    expect(environment).toEqual([
      `COMPUTER_BOT_ID=${key}`,
      `COMPUTER_TOKEN=${computerInstanceToken("deployment-secret", key)}`,
      "COMPUTER_TOKEN_IS_INSTANCE=true",
      "COMPUTER_BROWSER_MODE=headless",
    ]);
    // The one thing that must not survive: with it, a computer could derive
    // every other computer's token.
    expect(environment.join("\n")).not.toContain("deployment-secret");
  });

  test("leaves an environment without a token alone", () => {
    expect(
      computerInstanceEnvironment("deployment-secret", "computer-a", [
        "COMPUTER_BOT_ID=computer-a",
      ]),
    ).toEqual(["COMPUTER_BOT_ID=computer-a"]);
  });
});

describe("computerBotIdSignature", () => {
  const token = "deployment-secret";

  test("is deterministic, so the two sides agree without storing anything", () => {
    expect(computerBotIdSignature(token, "bot-a")).toBe(
      computerBotIdSignature(token, "bot-a"),
    );
  });

  test("differs per Bot, so one Bot's name cannot be replayed as another's", () => {
    // The whole point. On one computer the profile and workspace are chosen by this name, and the
    // name arrives on a header a caller controls.
    expect(computerBotIdSignature(token, "bot-a")).not.toBe(
      computerBotIdSignature(token, "bot-b"),
    );
  });

  test("differs per secret, so a leaked one cannot be used to sign anything", () => {
    expect(computerBotIdSignature(token, "bot-a")).not.toBe(
      computerBotIdSignature("other-secret", "bot-a"),
    );
  });

  test("is not the instance token, which is derived from a different key", () => {
    // Two derivations over one secret must not collide, or verifying one would verify the other.
    expect(computerBotIdSignature(token, "bot-a")).not.toBe(
      computerInstanceToken(token, "bot-a"),
    );
  });
});
