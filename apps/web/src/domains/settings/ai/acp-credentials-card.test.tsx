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

const ASSISTANT_ID = "asst-1";

const linkMock = mock(async (_args: LinkArgs) => ({
  data: { field: _args.body.field, linked: true },
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  acpCredentialsLinkPost: linkMock,
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

// The card self-fetches its assistant id via `assistantsListOptions`; mock the
// generated options factory and `useQuery` so the assistant id resolves the
// same way `EmailServiceCard` derives it (results[0].id). Tests that need the
// "no assistant" branch override `assistantListRef.results` to be empty.
const assistantListRef: { results: { id: string }[] } = {
  results: [{ id: ASSISTANT_ID }],
};

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsListOptions: () => ({
    queryKey: [{ _id: "assistantsList" }],
  }),
}));

mock.module("@tanstack/react-query", () => ({
  useQuery: () => ({ data: assistantListRef, isLoading: false, isError: false }),
}));

const { AcpCredentialsCard } = await import(
  "@/domains/settings/ai/acp-credentials-card"
);

afterEach(() => {
  cleanup();
  linkMock.mockClear();
  assistantListRef.results = [{ id: ASSISTANT_ID }];
});

describe("AcpCredentialsCard", () => {
  test("states the in-pod privacy model (transport vs storage)", () => {
    const { getByText } = render(<AcpCredentialsCard />);
    // Distinguishes transport (sent over an encrypted connection, which DOES
    // transit Vellum) from storage (only in the private pod, not persisted
    // centrally) — it must NOT claim the secret is "never sent to our servers".
    const notice = getByText(/private assistant environment/i);
    expect(notice).toBeDefined();
    expect(notice.textContent).toMatch(/sent over an encrypted connection/i);
    expect(notice.textContent).toMatch(
      /aren't persisted or readable on Vellum's servers/i,
    );
    expect(notice.textContent).not.toMatch(/never sent to our servers/i);
  });

  test("links the git token, then Replace overwrites the stored secret", async () => {
    const { getByLabelText, getByText, queryByText, queryByLabelText } = render(
      <AcpCredentialsCard />,
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

  test("switching the Claude dropdown during replace and linking clears the replace form", async () => {
    const { getByLabelText, getByText, queryByText, queryByLabelText } = render(
      <AcpCredentialsCard />,
    );

    // Link the Claude OAuth token (the default dropdown mode).
    const claudeInput = getByLabelText(
      "Claude OAuth token",
    ) as HTMLInputElement;
    fireEvent.change(claudeInput, { target: { value: "claude_oauth" } });

    // The Claude row is the only credential row containing the mode dropdown
    // (combobox), so scope button lookup to that row to disambiguate it.
    const findClaudeButton = (text: string) =>
      Array.from(document.querySelectorAll("button")).find((b) => {
        if (b.textContent !== text) return false;
        const row = b.closest("div.rounded-lg");
        return row?.querySelector('[role="combobox"]') != null;
      });

    fireEvent.click(findClaudeButton("Link")!);
    await waitFor(() => {
      expect(linkMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(getByText(/Claude OAuth token linked/i)).toBeDefined();
    });

    // Start a replace, then switch the dropdown to the OTHER Claude credential.
    fireEvent.click(getByText("Replace"));
    await waitFor(() => {
      expect(queryByLabelText("Claude OAuth token")).not.toBeNull();
    });

    const trigger = document.querySelector(
      '[role="combobox"]',
    ) as HTMLElement;
    fireEvent.click(trigger);
    const apiKeyOption = await waitFor(() => {
      const el = Array.from(
        document.querySelectorAll('[role="option"]'),
      ).find((o) => o.textContent?.includes("Anthropic API key"));
      expect(el).toBeDefined();
      return el as HTMLElement;
    });
    fireEvent.click(apiKeyOption);

    const apiKeyInput = (await waitFor(() => {
      const el = queryByLabelText("Anthropic API key") as HTMLInputElement | null;
      expect(el).not.toBeNull();
      return el!;
    })) as HTMLInputElement;

    // Submit the new (Anthropic API key) credential.
    fireEvent.change(apiKeyInput, { target: { value: "sk-ant" } });
    fireEvent.click(findClaudeButton("Replace")!);

    await waitFor(() => {
      expect(linkMock).toHaveBeenCalledTimes(2);
    });
    expect(linkMock.mock.calls[1]![0]).toMatchObject({
      body: { field: "anthropic_api_key", value: "sk-ant" },
    });

    // The replace form must be gone: linked state shows, no input lingers.
    await waitFor(() => {
      expect(getByText(/Anthropic API key linked/i)).toBeDefined();
    });
    expect(queryByLabelText("Anthropic API key")).toBeNull();
    expect(queryByLabelText("Claude OAuth token")).toBeNull();
    expect(
      queryByText(/Enter a new value to overwrite the stored credential/i),
    ).toBeNull();
  });

  test("does not call the daemon when no assistant is present", () => {
    assistantListRef.results = [];
    const { getByText, queryByLabelText } = render(<AcpCredentialsCard />);
    expect(getByText(/No assistant found yet/i)).toBeDefined();
    expect(queryByLabelText("Git token")).toBeNull();
    expect(linkMock).not.toHaveBeenCalled();
  });
});
