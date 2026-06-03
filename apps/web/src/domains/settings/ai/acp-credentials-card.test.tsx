/**
 * Tests for `AcpCredentialsCard` — the "Connect Claude Code / Codex + Git"
 * settings flow.
 *
 * Strategy mirrors `general-page.test.tsx`: render the card directly, mock the
 * generated daemon SDK's `acpCredentialsLinkPost`, and drive the link/unlink
 * UI with testing-library. Asserts that:
 *   - the in-pod privacy copy renders,
 *   - linking the Git token POSTs `{ field: "git_token", value }` and flips the
 *     row to the linked state (optimistic, since the route is write-only),
 *   - "Unlink" returns the row to the input state.
 */
import {
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

interface LinkArgs {
  path: { assistant_id: string };
  body: { field: string; value: string };
}

const linkMock = mock(async (_args: LinkArgs) => ({
  data: { field: _args.body.field, linked: true },
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  acpCredentialsLinkPost: linkMock,
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const { AcpCredentialsCard } = await import(
  "@/domains/settings/ai/acp-credentials-card"
);

const ASSISTANT_ID = "asst-1";

afterEach(() => {
  cleanup();
  linkMock.mockClear();
});

describe("AcpCredentialsCard", () => {
  test("states the in-pod privacy model", () => {
    const { getByText } = render(
      <AcpCredentialsCard assistantId={ASSISTANT_ID} />,
    );
    expect(
      getByText(/stored only in your private environment/i),
    ).toBeDefined();
    expect(getByText(/never sent to our servers/i)).toBeDefined();
  });

  test("links the git token and shows linked + unlink, then unlinks", async () => {
    const { getByLabelText, getByText, queryByLabelText } = render(
      <AcpCredentialsCard assistantId={ASSISTANT_ID} />,
    );

    const gitInput = getByLabelText("Git token") as HTMLInputElement;
    fireEvent.change(gitInput, { target: { value: "ghp_secret" } });

    // The Git row's Link button is the third "Link" button (Claude, OpenAI, Git).
    const linkButtons = document.querySelectorAll("button");
    const gitLinkButton = Array.from(linkButtons).find(
      (b) =>
        b.textContent === "Link" &&
        b.closest("div")?.querySelector('[aria-label="Git token"]') != null,
    );
    expect(gitLinkButton).toBeDefined();
    fireEvent.click(gitLinkButton!);

    await waitFor(() => {
      expect(linkMock).toHaveBeenCalledTimes(1);
    });
    expect(linkMock.mock.calls[0]![0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID },
      body: { field: "git_token", value: "ghp_secret" },
    });

    // Optimistic linked state: status + unlink affordance render.
    await waitFor(() => {
      expect(getByText(/Git token linked/i)).toBeDefined();
    });
    expect(queryByLabelText("Git token")).toBeNull();

    // Unlink returns the row to the input state.
    fireEvent.click(getByText("Unlink"));
    await waitFor(() => {
      expect(queryByLabelText("Git token")).not.toBeNull();
    });
  });

  test("does not call the daemon when no assistant is present", () => {
    const { getByText, queryByLabelText } = render(
      <AcpCredentialsCard assistantId={undefined} />,
    );
    expect(getByText(/No assistant found yet/i)).toBeDefined();
    expect(queryByLabelText("Git token")).toBeNull();
    expect(linkMock).not.toHaveBeenCalled();
  });
});
