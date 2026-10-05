import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Which Bot the surface in front of you is driving.
 *
 * The computer tools are registered once for the whole app, but a computer belongs to a Bot, and a supervisor gives
 * each one its own browser profile and its own egress, and the server picks which by the id in the
 * URL.
 *
 * Tool handlers read the ref because a handler outlives the render that registered it. Components
 * read state because grants and renderers must re-render when the active Bot changes.
 */

const DEFAULT_BOT_ID = "default";

export type BotHolder = { current: string };

const ActiveBotContext = createContext<BotHolder | null>(null);
const ActiveBotValueContext = createContext<{
  botId: string;
  announce: (botId: string) => void;
} | null>(null);

export function ActiveBotProvider({ children }: { children: ReactNode }) {
  const holder = useRef<BotHolder>({ current: DEFAULT_BOT_ID });
  const [botId, setBotId] = useState(DEFAULT_BOT_ID);
  const value = useRef({ botId, announce: setBotId });
  value.current = { botId, announce: setBotId };

  return (
    <ActiveBotContext.Provider value={holder.current}>
      <ActiveBotValueContext.Provider value={value.current}>
        {children}
      </ActiveBotValueContext.Provider>
    </ActiveBotContext.Provider>
  );
}

/**
 * Declare the Bot this surface drives, for as long as it is mounted.
 *
 * Restores what it found on unmount, so leaving a channel does not leave its Bot addressed by
 * whatever mounts next.
 */
export function useActiveBot(botId: string | undefined): void {
  const holder = useContext(ActiveBotContext);
  const value = useContext(ActiveBotValueContext);
  useEffect(() => {
    if (!holder) return;
    return declareActiveBot(holder, botId, value?.announce);
  }, [holder, value, botId]);
}

/**
 * The declaration itself, as a function of the holder rather than of a component.
 *
 * The rule that matters is which value survives a surface going away, and it is a rule about two
 * assignments — not about React. So it lives here, callable, and the effect above is the two lines
 * that hand it a holder. That also makes it testable without a renderer: the effect this used to be
 * tested through was the one piece of this file that could not be exercised deterministically, because
 * whether a `useEffect` has run depends on which scheduler React resolved at import time — which in
 * this suite is settled by a preload that registers a DOM, lets React choose, and then takes the DOM
 * away again. The test failed on CI and passed on a laptop for exactly that reason, on code that was
 * correct either way.
 *
 * RETURNS THE RESTORE, which is the interesting half: see below.
 */
export function declareActiveBot(
  holder: BotHolder,
  botId: string | undefined,
  announce?: (botId: string) => void,
): () => void {
  const previous = holder.current;
  const declared = botId ?? DEFAULT_BOT_ID;
  holder.current = declared;
  announce?.(declared);
  return () => {
    /*
     * THE PLACEHOLDER IS RESTORED ONLY OVER ANOTHER REAL VALUE.
     *
     * A run does not end when this surface unmounts. A computer tool call is executed by the browser
     * AFTER the run that asked for it has finished, so a turn still in flight outlives the page that
     * started it, and the handler reads this holder at the moment it runs. Leaving a chat for another
     * page in the app unmounts this effect while that call is still coming, and restoring `"default"`
     * here sent it to a Bot that does not exist: the call came back "your computer could not be
     * reached", the chain stopped mid-task, and the only way forward was to type "continue".
     *
     * So the last real Bot stands until another surface declares its own, which is what the restore is
     * for anyway — it exists so one channel cannot leave its Bot addressed to whatever mounts next, and
     * a surface that declares nothing has no claim on the value to take back.
     */
    if (previous === DEFAULT_BOT_ID) return;
    holder.current = previous;
    announce?.(previous);
  };
}

/** The holder itself, to be read inside a handler at the moment it runs. */
export function useActiveBotHolder(): BotHolder {
  return useContext(ActiveBotContext) ?? { current: DEFAULT_BOT_ID };
}

/** The active Bot as a value, for anything that has to re-render when it changes. */
export function useActiveBotId(): string {
  return useContext(ActiveBotValueContext)?.botId ?? DEFAULT_BOT_ID;
}

/**
 * The active Bot when a surface has declared one, and undefined while the placeholder holds.
 *
 * The placeholder exists so a handler always has something to route with, but it is not a Bot: no
 * package registers an agent by that name, and the server answers 404 for it. A grant query handed
 * the placeholder therefore polls a guaranteed miss on its own interval — every few seconds, on
 * every screen without a conversation — and the constant failing request is noise that would bury a
 * real 404 the day one matters. A query given undefined instead simply does not run.
 *
 * The name is already reserved in practice: an agents.yaml entry called "default" would be
 * indistinguishable from the placeholder in every handler that reads the holder.
 */
export function declaredBotId(botId: string): string | undefined {
  return botId === DEFAULT_BOT_ID ? undefined : botId;
}

/** As useActiveBotId, for callers that should do nothing while the placeholder holds. */
export function useDeclaredBotId(): string | undefined {
  return declaredBotId(useActiveBotId());
}
