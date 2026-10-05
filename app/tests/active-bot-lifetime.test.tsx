import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { render } from "@testing-library/react";
import {
  ActiveBotProvider,
  type BotHolder,
  declareActiveBot,
  useActiveBotHolder,
} from "../src/lib/copilot/active-bot";

/**
 * Which Bot a computer tool call is addressed to, at the moment it runs.
 *
 * The handlers read a ref rather than state, because a handler outlives the render that registered it
 * — and that is the whole bug. A computer tool call is executed by the browser AFTER the run that
 * asked for it has finished, so a turn in flight outlives the page that started it. Leaving a chat for
 * another page in the app unmounts the surface mid-run, and if the holder falls back to the placeholder
 * the call is addressed to a Bot that does not exist: it comes back "your computer could not be
 * reached", the chain stops where it stood, and the only way on is to type "continue".
 *
 * THE RULE IS TESTED WITHOUT A RENDERER, and that is the point rather than a shortcut. Which value
 * survives a surface going away is a fact about two assignments to one object, so it is tested as
 * one. The earlier version of this file mounted a component and waited for `useEffect`, and it passed
 * on a laptop and failed on CI on the same commit: whether an effect has run depends on which
 * scheduler React resolved when it was first imported, and this suite's preload registers a DOM, lets
 * React choose a browser scheduler, and then takes the DOM away again — so the callback that was
 * supposed to deliver the effect had nothing left to deliver it. `declareActiveBot` is that effect,
 * called directly, and the guarantee no longer depends on anything but the code under test.
 */

/*
 * A DOM for the one test that mounts. Registering it here is unrelated to what failed on CI: that was
 * an effect that never ran, not a missing document.
 */
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

/** Both holders two surfaces under ONE provider handed out, which is the comparison that means something. */
function holdersUnderOneProvider(): [BotHolder, BotHolder] {
  const captured: BotHolder[] = [];
  function Capture() {
    captured.push(useActiveBotHolder());
    return null;
  }
  render(
    <ActiveBotProvider>
      <Capture />
      <Capture />
    </ActiveBotProvider>,
  );
  if (captured.length < 2)
    throw new Error("the provider did not hand out a holder");
  return [captured[0] as BotHolder, captured[1] as BotHolder];
}

describe("a Bot declared by a surface that has gone away", () => {
  test("is still what a pending tool call is addressed to", () => {
    const holder: BotHolder = { current: "default" };

    // A surface declares its Bot. This is what a channel does on mount.
    const leave = declareActiveBot(holder, "bot-1");
    expect(holder.current).toBe("bot-1");

    // The person walks to another page in the app. The run is still going.
    leave();

    // Not the placeholder. That value has no agent behind it, so a call sent there cannot be carried
    // out and the turn dies where it stood.
    expect(holder.current).toBe("bot-1");
  });

  test("a second surface still takes the value for itself", () => {
    const holder: BotHolder = { current: "default" };

    // The restore exists so one channel cannot leave its Bot addressed to whatever mounts next, and
    // that has to keep working: a real previous value IS restored.
    const leaveFirst = declareActiveBot(holder, "bot-1");
    const leaveSecond = declareActiveBot(holder, "bot-2");
    expect(holder.current).toBe("bot-2");

    leaveSecond();
    expect(holder.current).toBe("bot-1");

    /*
     * And the FIRST surface leaving changes nothing, which is the same rule seen from the other side:
     * it found the placeholder when it arrived, so it has no claim on the value to take back. Were it
     * to restore `"default"` here, a run still in flight on some other page would be addressed to a Bot
     * that does not exist — which is the bug this file exists for.
     */
    leaveFirst();
    expect(holder.current).toBe("bot-1");
  });

  test("a surface that declares nothing takes the placeholder", () => {
    const holder: BotHolder = { current: "default" };
    const leave = declareActiveBot(holder, undefined);
    expect(holder.current).toBe("default");
    leave();
  });

  test("what it announced is what a component would re-render with", () => {
    const holder: BotHolder = { current: "default" };
    const announced: string[] = [];
    const leave = declareActiveBot(holder, "bot-1", (id) => announced.push(id));
    leave();
    expect(announced).toEqual(["bot-1"]);
  });

  test("every surface under one provider holds the same object, which is what makes a late read mean anything", () => {
    // Two reads, ONE provider: a handler registered by one surface and a component reading after
    // another has gone are looking at the same ref, or none of the above is worth anything. Two
    // providers would hold two objects, and comparing those would say nothing either way.
    const [first, second] = holdersUnderOneProvider();
    expect(second).toBe(first);
    expect(first.current).toBe("default");
  });
});
