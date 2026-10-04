import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

/**
 * ONE TURN'S WORK, FOLDED.
 *
 * A turn that took three steps used to leave three permanent rows in the transcript — a shell
 * command, a file read, a search — each a full line, each in the same voice as the answer, and the
 * answer itself the only part of the four anybody had asked for. On a conversation with twenty turns
 * in it that is sixty lines of process sitting at the same weight as the thing the person came back
 * to read.
 *
 * So the work is one row, and the row is a disclosure. While the answer is still being produced the
 * disclosure is OPEN and the header shimmers, because the whole point of watching a Bot work is
 * watching it work: the commands, the thinking, the steps it is taking, in the order it takes them.
 * The moment the answer itself starts arriving the disclosure folds to a single line, and from then
 * on it is a record of how the answer was reached rather than a thing being reached.
 *
 * The header says which of those two states it is in — `Working` while open, `Worked` once folded —
 * so a person reading back through a conversation can tell at a glance which turns were jobs and
 * which were sentences, and open the ones they want.
 *
 * A PERSON'S OWN TOGGLE WINS, for as long as the turn lasts. Somebody who opens a group to read what
 * a command actually printed does not have it taken away from them by the answer arriving a second
 * later; the automatic fold is skipped for them until the next turn starts. `touched` is how that is
 * remembered, and it is a ref rather than state because opening a group must not re-render the
 * transcript to record that the person opened it.
 *
 * `open` is written imperatively, onto the `<details>`, for the reason `ToolLine` gives: the SDK can
 * re-invoke a tool renderer independently of this component's React state, so React state is not a
 * safe place to hold whether the disclosure is open. Setting `.open` on the element is the one
 * thing both of them are looking at.
 */
export function ThoughtProcess({
  answered,
  busy,
  children,
}: {
  /** The answer this work produced has started streaming. See `groupChatWork`. */
  answered: boolean;
  /** A turn is in flight anywhere in this conversation, which is what makes open work say so. */
  busy: boolean;
  /** The rows, in the order they happened. */
  children: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const touched = useRef(false);

  /*
   * LIVE WHILE THE ANSWER IS STILL TO COME, and this is the whole of the automatic behaviour:
   * `!answered` is the work-in-progress case, and `busy` is what stops a finished conversation from
   * being drawn mid-fold. Both matter — a group whose answer already arrived while some LATER turn
   * is running must not spring back open — so both are read.
   */
  const live = !answered && busy;

  useEffect(() => {
    const element = detailsRef.current;
    if (element === null || touched.current) return;
    element.open = live;
  }, [live]);

  return (
    <details
      className="thought-process my-1.5 min-w-0"
      onToggle={(event) => {
        const element = event.currentTarget;
        // A toggle the effect caused is not a person choosing; only a toggle that lands on a state
        // we did not just write is. The effect writes `.open` synchronously above, so anything that
        // arrives here afterwards with the opposite value is the person's own doing.
        if (element.open === live) return;
        touched.current = true;
      }}
      ref={detailsRef}
    >
      <summary className="flex cursor-pointer list-none items-baseline gap-1.5">
        <span
          aria-hidden
          className="thought-process-chevron shrink-0 text-xs text-muted-foreground transition-transform"
        >
          ▸
        </span>
        <span
          className={`inline-flex min-w-0 max-w-full items-baseline text-sm text-muted-foreground ${
            live ? "tool-line-running" : ""
          }`}
        >
          {live ? "Working" : "Worked"}
        </span>
      </summary>
      {/*
       * The detail body is muted and small, and its left rule is the same one a tool result is drawn
       * behind, so a folded group and an expanded tool line are the same visual object at two
       * sizes. `gap-2` between rows because these are separate events, not lines of one paragraph.
       */}
      <div className="mt-2 flex flex-col gap-2 border-l pl-3">{children}</div>
    </details>
  );
}
