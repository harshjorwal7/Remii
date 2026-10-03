import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { agentInputFrom } from "@/lib/agents/form";
import { MascotPicker } from "@/mascot/mascot-picker";
import type { MascotChoice } from "../../shared/mascot-ids";
import {
  MASCOT_COMBINATION_COUNT,
  MASCOT_SHAPE_IDS,
} from "../../shared/mascot-ids";

GlobalRegistrator.register({ url: "https://remii.test/" });
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** Mirrors how a form actually uses it: held in state, read out on submit. */
function Harness({
  initial,
  onChange,
}: {
  initial: Partial<MascotChoice> | undefined;
  onChange?: (next: Partial<MascotChoice> | undefined) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <MascotPicker
        seed="agent_01HX8QK2M4P"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <output data-testid="current">{JSON.stringify(value ?? null)}</output>
    </>
  );
}

const current = (container: HTMLElement) =>
  JSON.parse(
    container.querySelector("[data-testid=current]")?.textContent ?? "null",
  );

function swatch(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    (b.getAttribute("aria-label") ?? b.textContent ?? "").includes(label),
  );
  if (!button) throw new Error(`no swatch labelled ${label}`);
  return button;
}

/**
 * Why the heaviest cases carry a long timeout.
 *
 * The picker renders nine mascots at once — more SVG than any other component in this file's
 * neighbourhood — and under load, with the visual suite running Chrome in the same process, a
 * synchronous `render` of one of these has been measured at ten and a half seconds and timed out.
 * That is a slow machine talking about happy-dom, not a failing assertion, and a test that reports it
 * as a failure sends the next person looking for a mascot bug that is not there.
 *
 * It was twenty-five before the expression row went, and it was measured then.
 */
const RENDER_TIMEOUT = 30_000;

describe("MascotPicker", () => {
  it("offers every shape and every colour, and no black, brown or grey among them", () => {
    const { container } = render(<Harness initial={undefined} />);
    // Counted through the DOM rather than the vocabulary, so a row that renders but cannot be reached
    // shows up here instead of only in a unit test of the list itself.
    for (const legend of ["Shape", "Colour"]) {
      const fieldset = [...container.querySelectorAll("fieldset")].find((f) =>
        f.querySelector("legend")?.textContent?.includes(legend),
      );
      expect(fieldset, `no ${legend} row`).toBeTruthy();
      expect(fieldset?.querySelectorAll("button").length).toBeGreaterThan(0);
    }
    // Seven shapes by nine colours. It was eight by twelve while a droplet and two dark swatches were
    // still in the palette, and every one of the three failed a row of mascots in a sidebar.
    expect(MASCOT_COMBINATION_COUNT).toBe(63);
    for (const swatch of [
      ...container.querySelectorAll("button[aria-label]"),
    ]) {
      expect(["ink", "brown", "grey"]).not.toContain(
        swatch.getAttribute("aria-label"),
      );
    }
  });

  it("offers no expression, because the face is the work and not a preference", () => {
    // The row that used to be here had sixteen faces on it and was the wrong control: choosing one
    // meant choosing how the coworker would look while it was stuck, while it streamed, and while it
    // had failed. So the assertion is that the row is gone and that the copy says where the face went,
    // rather than only that the sixteen swatches are no longer rendered — a picker that hid the row
    // silently would look identical to a picker that had removed the feature.
    const { container } = render(<Harness initial={undefined} />);
    const legends = [...container.querySelectorAll("legend")].map((l) =>
      (l.textContent ?? "").trim(),
    );
    expect(legends).toEqual(["Shape", "Colour"]);
    expect(container.textContent).toContain("face follows");
  });

  it("starts at nothing chosen, which is the state most coworkers are in", () => {
    const { container } = render(<Harness initial={undefined} />);
    expect(current(container)).toBeNull();
    expect(container.textContent).toContain("Not chosen");
  });

  it("records one axis at a time and leaves the others alone", () => {
    const onChange = () => {};
    const { container } = render(
      <Harness initial={undefined} onChange={onChange} />,
    );
    fireEvent.click(swatch(container, "teal"));
    // Only the colour. The shape stays unchosen so it keeps being seeded, which is what makes a
    // partly-dressed coworker still differ from its siblings.
    expect(current(container)).toEqual({ color: "teal" });
  });

  it("adds to an existing choice rather than replacing it", () => {
    const { container } = render(<Harness initial={{ color: "teal" }} />);
    fireEvent.click(swatch(container, "Hexagon"));
    expect(current(container)).toEqual({ color: "teal", shape: "hexagon" });
  });

  it("swaps a chosen axis rather than accumulating it", () => {
    const { container } = render(
      <Harness initial={{ color: "teal", shape: "cloud" }} />,
    );
    fireEvent.click(swatch(container, "Hexagon"));
    expect(current(container)).toEqual({ color: "teal", shape: "hexagon" });
  });

  it("goes back to nothing chosen on reset, and says so", () => {
    const { container } = render(
      <Harness initial={{ color: "teal", shape: "cloud" }} />,
    );
    expect(container.textContent).not.toContain("Not chosen");
    fireEvent.click(swatch(container, "Reset"));
    expect(current(container)).toBeNull();
    expect(container.textContent).toContain("Not chosen");
  });

  it("marks the current choice as pressed so the row says where it is", () => {
    const { container } = render(
      <Harness initial={{ color: "violet", shape: "cloud" }} />,
    );
    expect(swatch(container, "violet").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(swatch(container, "teal").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(swatch(container, "Cloud").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it(
    "gives every swatch a name, because eight unnamed shapes are not learnable",
    () => {
      const { container } = render(<Harness initial={undefined} />);
      const unnamed = [...container.querySelectorAll("button")].filter(
        (b) => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label"),
      );
      expect(unnamed).toEqual([]);
    },
    RENDER_TIMEOUT,
  );

  it(
    "draws every swatch as a still frame, so eight of them cost eight paints",
    () => {
      const { container } = render(<Harness initial={undefined} />);
      const mascots = container.querySelectorAll(
        "fieldset svg, span svg, [role=img] > svg",
      );
      // One per shape swatch plus the single live preview at the top; the colours are flat hex buttons.
      // The preview is the only one that should be moving; if the swatches animated too, picking a
      // shape would start an engine per swatch. Counted exactly, because this is the assertion that
      // stops a reintroduced row of faces from quietly becoming sixteen more engines.
      expect(mascots.length).toBe(MASCOT_SHAPE_IDS.length + 1);
      // And the two tabler icons in the buttons are SVG too, which is why the naive count above is a
      // trap: it reads as three more mascots and would have been "fixed" by loosening the number.
      expect(container.querySelectorAll("svg").length).toBe(
        MASCOT_SHAPE_IDS.length + 3,
      );
    },
    RENDER_TIMEOUT,
  );

  it("does not put a mascot on a form that was never told about one", () => {
    // The distinction the server reads: absent means "leave the row alone", and an always-present
    // mascot would freeze every seeded coworker the first time somebody saved an unrelated field.
    const input = agentInputFrom({
      name: "Rae",
      title: "Chief of Staff",
      roleDescription: "Keeps the day in order.",
      visibility: "private",
      mascot: undefined,
    });
    expect("mascot" in input).toBe(false);
  });

  it("sends an empty object as a deliberate reset", () => {
    const input = agentInputFrom({
      name: "Rae",
      title: "Chief of Staff",
      roleDescription: "Keeps the day in order.",
      visibility: "private",
      mascot: {},
    });
    expect(input.mascot).toEqual({});
  });
});
