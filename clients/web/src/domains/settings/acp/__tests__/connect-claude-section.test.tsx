/**
 * Tests for the Connect Claude Code settings section.
 *
 * Covers the three surfaces of the ACP OAuth flow: the loopback (desktop)
 * one-click path that polls to "connected", the manual (cloud) one-paste path
 * that exchanges a `code#state`, and the flag gate that hides the section.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

let flagEnabled = true;

const openUrl = mock(async (_url: string) => {});
mock.module("@/runtime/browser", () => ({
  openUrl,
  openUrlFinishedListener: () => () => {},
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-123",
}));

mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    acpClaudeOauthConnect: () => flagEnabled,
  };
  return { useAssistantFeatureFlagStore: store };
});

const startConnectClaude = mock(async (_assistantId: string) => ({
  mode: "loopback" as "loopback" | "manual",
  authorize_url: "https://claude.ai/oauth?x=1",
  state: "state-abc",
}));
const pollConnectClaudeStatus = mock(
  async (_assistantId: string, _state: string) => ({
    status: "connected" as "pending" | "connected" | "error",
  }),
);
const exchangeConnectClaude = mock(
  async (_assistantId: string, _code: string, _state: string) => {},
);
mock.module("@/hooks/connect-claude-api", () => ({
  startConnectClaude,
  pollConnectClaudeStatus,
  exchangeConnectClaude,
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    size?: string;
    variant?: string;
    onClick?: () => void;
    disabled?: boolean;
  }) => <button {...props}>{children}</button>,
}));

mock.module("@vellumai/design-library/components/input", () => ({
  Input: ({
    fullWidth: _fullWidth,
    ...props
  }: {
    fullWidth?: boolean;
    value?: string;
    placeholder?: string;
    onChange?: (e: unknown) => void;
  }) => <input {...props} />,
}));

mock.module("@vellumai/design-library/components/typography", () => ({
  Typography: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
}));

const { ConnectClaudeSection } = await import("../connect-claude-section");

beforeEach(() => {
  flagEnabled = true;
  openUrl.mockClear();
  startConnectClaude.mockClear();
  startConnectClaude.mockImplementation(async () => ({
    mode: "loopback",
    authorize_url: "https://claude.ai/oauth?x=1",
    state: "state-abc",
  }));
  pollConnectClaudeStatus.mockClear();
  pollConnectClaudeStatus.mockImplementation(async () => ({
    status: "connected",
  }));
  exchangeConnectClaude.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ConnectClaudeSection", () => {
  test("does not render when the flag is off", () => {
    flagEnabled = false;

    render(<ConnectClaudeSection />);

    expect(screen.queryByText("Connect Claude Code")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Connect Claude Code" }),
    ).toBeNull();
  });

  test("loopback flow: start opens the browser, polls, then shows connected", async () => {
    render(<ConnectClaudeSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Connect Claude Code" }),
    );

    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://claude.ai/oauth?x=1"),
    );
    expect(startConnectClaude).toHaveBeenCalledWith("assistant-123");

    await waitFor(
      () => expect(screen.getByText("Claude Code connected.")).not.toBeNull(),
      {
        timeout: 4000,
        interval: 50,
      },
    );
    expect(pollConnectClaudeStatus).toHaveBeenCalledWith(
      "assistant-123",
      "state-abc",
    );
  }, 10000);

  test("manual flow: shows the paste field and exchanges the pasted code", async () => {
    startConnectClaude.mockImplementation(async () => ({
      mode: "manual",
      authorize_url: "https://claude.ai/oauth?x=2",
      state: "state-xyz",
    }));

    render(<ConnectClaudeSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Connect Claude Code" }),
    );

    const input = await screen.findByPlaceholderText("Paste code here...");
    fireEvent.change(input, { target: { value: "code-123#state-xyz" } });

    fireEvent.click(
      screen.getByRole("button", { name: "Complete Connection" }),
    );

    await waitFor(() =>
      expect(exchangeConnectClaude).toHaveBeenCalledWith(
        "assistant-123",
        "code-123#state-xyz",
        "state-xyz",
      ),
    );
    expect(await screen.findByText("Claude Code connected.")).not.toBeNull();
    // The manual path never opens a loopback poll.
    expect(pollConnectClaudeStatus).not.toHaveBeenCalled();
  });
});
