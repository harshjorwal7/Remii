import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import type { DesktopComputerUse } from "../src/computer/desktop-stream";
import { desktopToolsFor } from "../src/computer/desktop-tools";
import {
  ComputerRowExistsError,
  createUserComputerStore,
  HUMAN_HAS_CONTROL,
} from "../src/computer/user-computers";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";

/**
 * A desktop is one machine with one mouse and one keyboard.
 *
 * That is the whole reason the wheel exists, and it is why these tests care about the SENTENCE the
 * Bot gets back rather than only about the fact that it is stopped: a Bot told "refused" retries,
 * retries again, and then gives up, which looks like the computer being broken.
 */
const database = createDatabase(process.env.TEST_DATABASE_URL!);
const store = createUserComputerStore(database);

/** Users this file made, removed at the end so the database does not grow per run. */
const made: string[] = [];
afterAll(async () => {
  if (made.length === 0) return;
  // The foreign key cascades, so the computer rows go with their users.
  await database.delete(users).where(inArray(users.id, made));
});

async function makeUser(): Promise<string> {
  const id = `wheel-${crypto.randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@remii.test`, emailVerified: true })
    .returning();
  made.push(id);
  return id;
}

/** Counts what actually reached the desktop, so a refusal can be told from a success. */
function fakeComputer() {
  const acts: string[] = [];
  const computerUse = {
    screenshot: {
      takeCompressed: async () => ({ screenshot: "JPEG" }),
      takeFullScreen: async () => ({ screenshot: "PNG" }),
    },
    mouse: {
      move: async (x: number, y: number) => void acts.push(`move ${x},${y}`),
      click: async (x: number, y: number) => void acts.push(`click ${x},${y}`),
      scroll: async () => void acts.push("scroll"),
    },
    keyboard: {
      type: async (t: string) => void acts.push(`type ${t}`),
      press: async () => void acts.push("press"),
      hotkey: async () => void acts.push("hotkey"),
    },
    display: {
      getInfo: async () => ({
        displays: [{ width: 1920, height: 1080, isActive: true }],
      }),
      getWindows: async () => ({
        windows: [{ id: 1, title: "Firefox", isActive: true }],
      }),
    },
    accessibility: {
      getTree: async () => ({
        root: { role: "application", name: "xfwm4", children: [] },
      }),
    },
  } as unknown as DesktopComputerUse;
  return { computerUse, acts };
}

function toolsFor(userId: string, computer: ReturnType<typeof fakeComputer>) {
  return desktopToolsFor({
    resolve: async () => ({ computerUse: computer.computerUse }),
    actor: { id: userId },
    botId: "probe",
    controlHolder: async () =>
      (await store.get(userId))?.controlHolder ?? "bot",
  });
}

const byName = (tools: ReturnType<typeof desktopToolsFor>, name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

describe("who has the wheel", () => {
  test("a new computer starts with the Bot holding it", async () => {
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    expect((await store.get(userId))?.controlHolder).toBe("bot");
  });

  test("a person takes it and hands it back, and the row is the record", async () => {
    // On the row rather than in a socket, because the person and the Bot are on different
    // connections and both have to read the same answer.
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    expect(
      (await store.patch(userId, { controlHolder: "human" }))?.controlHolder,
    ).toBe("human");
    expect(
      (await store.patch(userId, { controlHolder: "bot" }))?.controlHolder,
    ).toBe("bot");
  });

  test("one person's wheel says nothing about anybody else's", async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId: mine,
      provider: "e2b",
    });
    await store.create({
      id: crypto.randomUUID(),
      userId: theirs,
      provider: "e2b",
    });
    await store.patch(mine, { controlHolder: "human" });
    expect((await store.get(mine))?.controlHolder).toBe("human");
    expect((await store.get(theirs))?.controlHolder).toBe("bot");
  });
});

describe("a Bot with a person at the keyboard", () => {
  test("every ACTING tool is refused, and nothing reaches the desktop", async () => {
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    await store.patch(userId, { controlHolder: "human" });
    const computer = fakeComputer();
    const tools = toolsFor(userId, computer);

    for (const [name, args] of [
      ["computer_click", { x: 10, y: 10 }],
      ["computer_type", { text: "hello" }],
      ["computer_key", { keys: "Enter" }],
      ["computer_scroll", { x: 1, y: 1, amount: 3 }],
    ] as const) {
      expect(await byName(tools, name).execute(args)).toBe(HUMAN_HAS_CONTROL);
    }
    expect(computer.acts).toEqual([]);
  });

  test("the refusal tells the Bot WHY, so it waits instead of retrying", async () => {
    // The difference between "refused" and a sentence is the difference between a Bot that backs
    // off for thirty seconds and a Bot that decides the computer is broken.
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    await store.patch(userId, { controlHolder: "human" });
    const answer = await byName(
      toolsFor(userId, fakeComputer()),
      "computer_click",
    ).execute({ x: 1, y: 1 });
    expect(answer).toContain("A person has control");
    expect(answer).toContain("hand the computer back");
  });

  test("a Bot can still SEE the screen while a person drives it", async () => {
    // Refusing the reads would make the Bot blind, which is not politeness — it is it working in
    // the dark. Only the acting tools are withheld.
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    await store.patch(userId, { controlHolder: "human" });
    const tools = toolsFor(userId, fakeComputer());
    expect(await byName(tools, "computer_screen").execute({})).not.toBe(
      HUMAN_HAS_CONTROL,
    );
    /*
     * AND THE PICTURE REALLY COMES BACK, which is the regression this whole assertion exists for.
     *
     * `computer_screenshot` used to answer `Screenshot taken (412 KB as a PNG)` — it fetched a
     * full-screen PNG, measured the base64 length to print a number, and threw the pixels away. The
     * model was told a screenshot existed and was sent none, so the only way it could learn what was
     * on the desktop was the AT-SPI tree, which on XFCE is a panel and a window manager. Every
     * "the Bot cannot use the computer" report traces back to this line.
     *
     * So the assertion is on the IMAGE, not on the sentence. A test that only checked the text would
     * have kept passing through the entire bug.
     */
    const shot = await byName(tools, "computer_screenshot").execute({});
    expect(typeof shot).not.toBe("string");
    expect((shot as { images?: unknown[] }).images).toHaveLength(1);
    const [image] = (shot as { images: { data: string; mimeType: string }[] })
      .images;
    // Real base64, not an empty string or a placeholder.
    expect(image.data.length).toBeGreaterThan(0);
    expect(image.mimeType).toBe("image/jpeg");
  });

  test("handing the wheel back lets the Bot act again", async () => {
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    const computer = fakeComputer();
    const tools = toolsFor(userId, computer);

    await store.patch(userId, { controlHolder: "human" });
    expect(await byName(tools, "computer_click").execute({ x: 5, y: 5 })).toBe(
      HUMAN_HAS_CONTROL,
    );
    expect(computer.acts).toEqual([]);

    await store.patch(userId, { controlHolder: "bot" });
    expect(await byName(tools, "computer_click").execute({ x: 5, y: 5 })).toBe(
      "Clicked at 5, 5. Look at the screen to check what happened.",
    );
    /*
     * ONE call, and this is the assertion that holds it there.
     *
     * This used to be `["move 5,5", "click 5,5"]` — an explicit `mouse.move` before every click. Both
     * are remote round trips to a remote sandbox, so the Bot's most frequent action paid double
     * latency for a move the click performs anyway. `click` takes the coordinates and moves there.
     *
     * The trailing nudge to verify is deliberate and is the same idea the screenshot fix rests on: a
     * click answers "Clicked at 5, 5" whether or not it landed, so the model is told to look.
     */
    expect(computer.acts).toEqual(["click 5,5"]);
  });

  test("a computer with no row at all lets the Bot act, rather than refusing everything", async () => {
    // The safe default is the Bot: a person who has not taken the wheel should not have to prove
    // they have not, and a Bot that meets a missing row should get on with the work.
    const userId = await makeUser();
    expect(
      await byName(toolsFor(userId, fakeComputer()), "computer_click").execute({
        x: 2,
        y: 2,
      }),
    ).toBe("Clicked at 2, 2. Look at the screen to check what happened.");
  });
});

describe("the store still refuses a second computer", () => {
  test("the wheel did not weaken the one-computer invariant", async () => {
    // Changing the row's shape must not quietly change what it enforces.
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    await expect(
      store.create({ id: crypto.randomUUID(), userId, provider: "e2b" }),
    ).rejects.toBeInstanceOf(ComputerRowExistsError);
  });
});
