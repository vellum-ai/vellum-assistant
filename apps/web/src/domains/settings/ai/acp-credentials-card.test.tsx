/**
 * Tests for `AcpCredentialsCard` — the "Connect Claude Code / Codex + Git"
 * settings flow.
 *
 * Strategy mirrors `general-page.test.tsx`: render the card directly, mock the
 * generated daemon SDK's `acpCredentialsLinkPost`, and drive the link/replace
 * UI with testing-library. Asserts that:
 *   - the in-pod privacy copy renders,
 *   - linking the Git token POSTs `{ field: "git_token", value }` and flips the
 *     row to a truthful linked state (optimistic, since the route is write-only),
 *   - "Replace" re-opens the input and posting a new value overwrites the stored
 *     secret (rotation) — there is no local-only "unlink" that falsely implies
 *     server-side removal.
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

  test("links the git token, then Replace overwrites the stored secret", async () => {
    const { getByLabelText, getByText, queryByText, queryByLabelText } = render(
      <AcpCredentialsCard assistantId={ASSISTANT_ID} />,
    );

    const gitInput = getByLabelText("Git token") as HTMLInputElement;
    fireEvent.change(gitInput, { target: { value: "ghp_secret" } });

    const findGitLinkButton = (text: string) =>
      Array.from(document.querySelectorAll("button")).find(
        (b) =>
          b.textContent === text &&
          b.closest("div")?.querySelector('[aria-label="Git token"]') != null,
      );

    const gitLinkButton = findGitLinkButton("Link");
    expect(gitLinkButton).toBeDefined();
    fireEvent.click(gitLinkButton!);

    await waitFor(() => {
      expect(linkMock).toHaveBeenCalledTimes(1);
    });
    expect(linkMock.mock.calls[0]![0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID },
      body: { field: "git_token", value: "ghp_secret" },
    });

    // Optimistic, truthful linked state: status + Replace affordance render;
    // there is NO "Unlink" affordance implying server-side removal.
    await waitFor(() => {
      expect(getByText(/Git token linked/i)).toBeDefined();
    });
    expect(queryByLabelText("Git token")).toBeNull();
    expect(queryByText("Unlink")).toBeNull();

    // Replace re-opens the input so the user can rotate the stored secret.
    fireEvent.click(getByText("Replace"));
    let replacedInput: HTMLInputElement | null = null;
    await waitFor(() => {
      replacedInput = queryByLabelText("Git token") as HTMLInputElement | null;
      expect(replacedInput).not.toBeNull();
    });

    // Entering a new value and submitting POSTs the overwrite (rotation).
    fireEvent.change(replacedInput!, { target: { value: "ghp_rotated" } });
    const replaceButton = findGitLinkButton("Replace");
    expect(replaceButton).toBeDefined();
    fireEvent.click(replaceButton!);

    await waitFor(() => {
      expect(linkMock).toHaveBeenCalledTimes(2);
    });
    expect(linkMock.mock.calls[1]![0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID },
      body: { field: "git_token", value: "ghp_rotated" },
    });

    // Back to the truthful linked state after the overwrite lands.
    await waitFor(() => {
      expect(getByText(/Git token linked/i)).toBeDefined();
    });
    expect(queryByLabelText("Git token")).toBeNull();
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
