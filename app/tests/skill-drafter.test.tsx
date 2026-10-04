import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillDrafts } from "@/components/skills/skill-drafter";
import { SkillFields } from "@/components/skills/skill-fields";
import { emptySkillForm, type SkillFormValues } from "@/lib/skills/form";

/**
 * Drafting a repository's skills into the New-skill form.
 *
 * TWO THINGS ARE ASSERTED, AND THE SECOND IS THE ONE THAT WOULD HAVE BEEN INVISIBLE. The first is
 * that a draft reaches the form: the button, the list and the click are all machinery, and a
 * regression there is visible. The second is that a NEW set of values actually lands in the inputs.
 * `useForm` reads `defaultValues` once, so the component under test has to reset the form by hand —
 * and a version that did not would still pass every other test in this file, because the button
 * would still work and the list would still draw. It would just save an empty skill, which is the
 * failure the whole feature exists to prevent.
 *
 * `fetch` is stubbed rather than a mutation injected: the point of these two files is the wiring
 * between a server answer and the fields on screen, and stubbing the transport tests that wiring
 * without inventing a seam in production code for the sake of a test.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const DRAFTS = {
  drafts: [
    {
      slug: "tauri-signing",
      title: "Tauri Windows signing",
      summary: "Sign a Windows build with the org certificate.",
      instructions: "Wire the signing command, then verify the signature.",
      source: "SKILL.md",
      existing: null,
    },
    {
      slug: "release-notes",
      title: "Release notes",
      summary: "",
      instructions: "Group what shipped by kind, newest first.",
      source: "skills/release-notes.md",
      existing: "yours" as const,
    },
  ],
  repository: {
    url: "https://github.com/owner/repo",
    ref: "main",
    path: "",
    fileCount: 12,
    truncated: false,
  },
};

/** The server answering `POST /skills/drafts` with the drafts above, or with a sentence. */
function answerWith(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function draw(children: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

test("a repository's skills arrive as drafts, and choosing one fills the form", async () => {
  answerWith(DRAFTS);
  let chosen: unknown = null;
  const view = draw(
    <SkillDrafts
      onChoose={(draft) => {
        chosen = draft;
      }}
      onDrafts={() => {}}
      saved={[]}
    />,
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.type(
    view.getByLabelText("Repository"),
    "https://github.com/owner/repo",
  );
  await user.click(view.getByRole("button", { name: /Draft skills/ }));

  await waitFor(() => {
    expect(view.getByText("/tauri-signing")).toBeTruthy();
  });
  // Two skills in the repository means two drafts, not one: the promise is "as many as it has".
  expect(view.getAllByRole("button", { name: "Use this draft" })).toHaveLength(
    2,
  );
  expect(view.getByText("Release notes")).toBeTruthy();

  await user.click(view.getAllByRole("button", { name: "Use this draft" })[0]);

  expect(chosen).toMatchObject({
    slug: "tauri-signing",
    // The address the person pasted, so a branch they named survives into the saved skill.
    repo: "https://github.com/owner/repo",
  });
});

test("a draft whose slug already exists says whose it is before the save", async () => {
  answerWith(DRAFTS);
  const view = draw(
    <SkillDrafts onChoose={() => {}} onDrafts={() => {}} saved={[]} />,
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.type(
    view.getByLabelText("Repository"),
    "https://github.com/owner/repo",
  );
  await user.click(view.getByRole("button", { name: /Draft skills/ }));

  await waitFor(() => {
    expect(view.getByText(/already exists/)).toBeTruthy();
  });
});

test("a slug already saved is not offered a second time", async () => {
  answerWith(DRAFTS);
  const view = draw(
    <SkillDrafts
      onChoose={() => {}}
      onDrafts={() => {}}
      saved={["tauri-signing"]}
    />,
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.type(
    view.getByLabelText("Repository"),
    "https://github.com/owner/repo",
  );
  await user.click(view.getByRole("button", { name: /Draft skills/ }));

  await waitFor(() => {
    expect(view.getByText("Release notes")).toBeTruthy();
  });
  // One draft left, and it is the other one: the saved slug must not be offered a second time, or a
  // repository whose first draft was saved would still be asking to save it again.
  expect(view.getAllByRole("button", { name: "Use this draft" })).toHaveLength(
    1,
  );
  expect(view.queryByText("/tauri-signing")).toBeNull();
});

test("the server's sentence is shown rather than a paraphrase", async () => {
  answerWith(
    { error: "GitHub says this repository does not exist, or is private." },
    404,
  );
  const view = draw(
    <SkillDrafts onChoose={() => {}} onDrafts={() => {}} saved={[]} />,
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.type(
    view.getByLabelText("Repository"),
    "https://github.com/owner/repo",
  );
  await user.click(view.getByRole("button", { name: /Draft skills/ }));

  await waitFor(() => {
    expect(
      view.getByText(
        "GitHub says this repository does not exist, or is private.",
      ),
    ).toBeTruthy();
  });
});

test("an address this cannot read is refused while it is typed", () => {
  const view = draw(
    <SkillDrafts onChoose={() => {}} onDrafts={() => {}} saved={[]} />,
  );
  expect(view.getByRole("button", { name: /Draft skills/ })).toHaveProperty(
    "disabled",
    true,
  );
});

test("values handed to the fields land in the inputs, and a new set replaces them", async () => {
  const first: SkillFormValues = {
    slug: "tauri-signing",
    title: "Tauri Windows signing",
    summary: "Sign a Windows build.",
    instructions: "Wire the signing command, then verify it.",
    tools: [],
    repo: "https://github.com/owner/repo",
  };
  const view = draw(
    <SkillFields
      defaultValues={emptySkillForm}
      onSubmit={async () => {}}
      submitLabel="Save skill"
      values={first}
    />,
  );
  await waitFor(() => {
    expect(view.getByDisplayValue("tauri-signing")).toBeTruthy();
  });
  expect(view.getByDisplayValue("Tauri Windows signing")).toBeTruthy();

  // THE REGRESSION THIS FILE EXISTS FOR: a second set of values, on a form that was already mounted.
  const second: SkillFormValues = { ...first, slug: "release-notes" };
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <SkillFields
        defaultValues={emptySkillForm}
        onSubmit={async () => {}}
        submitLabel="Save skill"
        values={second}
      />
    </QueryClientProvider>,
  );
  await waitFor(() => {
    expect(view.getByDisplayValue("release-notes")).toBeTruthy();
  });
  expect(view.queryByDisplayValue("tauri-signing")).toBeNull();
});
