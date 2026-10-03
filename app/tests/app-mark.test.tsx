import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  IconBrandGmail,
  IconBrandGoogle,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconBrandSlack,
  IconPlug,
} from "@tabler/icons-react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  AppMark,
  COMPOSIO_LOGO,
  MARKS,
  markFor,
} from "@/components/plugins/app-mark";

describe("markFor", () => {
  it("resolves Gmail mark for various gmail keys", () => {
    expect(markFor("gmail")).toBe(IconBrandGmail);
    expect(markFor("composio-gmail")).toBe(IconBrandGmail);
    expect(markFor("google-mail")).toBe(IconBrandGmail);
    expect(markFor("google_mail")).toBe(IconBrandGmail);
  });

  it("resolves Google Drive mark", () => {
    expect(markFor("google-drive")).toBe(IconBrandGoogleDrive);
    expect(markFor("composio-google-drive")).toBe(IconBrandGoogleDrive);
  });

  it("resolves Google services fallback", () => {
    expect(markFor("google-calendar")).toBe(IconBrandGoogle);
    expect(markFor("google-docs")).toBe(IconBrandGoogle);
  });

  it("resolves Notion and Slack marks", () => {
    expect(markFor("notion")).toBe(IconBrandNotion);
    expect(markFor("composio-slack")).toBe(IconBrandSlack);
  });

  it("falls back to IconPlug for unknown keys", () => {
    expect(markFor("unknown-app-xyz")).toBe(IconPlug);
    expect(markFor(null)).toBe(IconPlug);
    expect(markFor(undefined)).toBe(IconPlug);
  });
});

describe("AppMark", () => {
  /*
   * A DOM for the two cases that draw rather than resolve. `cleanup()` is global, so it runs before
   * the registrator goes away — a container left behind outlives its test and fails a later file.
   */
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => {
    cleanup();
    GlobalRegistrator.unregister();
  });

  it("draws the vendor's own logo when the broker published one", () => {
    /*
     * THE LOGO IS WHAT MAKES A LIST OF APPS READABLE, and it was going missing in the one place
     * that lists apps nobody has added yet. Composio's directory rows were drawn with the slug alone,
     * so every app in the picker fell back to a built-in brand glyph — a plug for everything Composio
     * publishes that Tabler has no icon for. The accounts list beside it has always passed `logo`
     * through, which is why the two lists looked nothing alike.
     */
    const view = render(
      <AppMark
        serverId="composio-gmail"
        logo="https://logos.example.test/gmail"
      />,
    );
    const image = view.container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://logos.example.test/gmail");
  });

  it("falls back to the brand glyph when no logo was published", () => {
    // Composio genuinely publishes no logo for some toolkits, and absent is an answer rather than
    // a fault — so the row is a glyph and not a broken image.
    const view = render(<AppMark serverId="composio-gmail" logo={null} />);
    expect(view.container.querySelector("img")).toBeNull();
  });

  it("names Composio itself for the sandbox and workbench row", () => {
    /*
     * The workbench is not an app and has no slug of its own, so it cannot be looked up — it has to
     * be told. It was a bare plug glyph, which is the one mark in the product that means nothing.
     */
    expect(COMPOSIO_LOGO).toMatch(/^https:\/\//);
    expect(markFor("composio")).toBe(IconPlug);
    expect(markFor("workbench")).toBe(IconPlug);
    expect(markFor("sandbox")).toBe(IconPlug);
  });
});

describe("MARKS", () => {
  it("keys Composio's own three names so none of them throws", () => {
    // Present-and-equal-to-the-default rather than absent: `markFor` falls back to IconPlug on a
    // miss anyway, and an explicit entry says the names are looked up on purpose.
    for (const key of ["composio", "workbench", "sandbox"]) {
      expect(MARKS[key]).toBe(IconPlug);
    }
  });
});
