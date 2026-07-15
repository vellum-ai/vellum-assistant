/**
 * Tests for the inline "Connect Claude Code" affordance rendered when an
 * `acp_spawn` fails for a missing OAuth token.
 *
 * Covers the marker predicate and the flag gate: the affordance renders its
 * Connect button when the `acp-claude-oauth-connect` flag is on, and nothing
 * (falling back to the plain error rendering) when it is off.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

let flagEnabled = true;

mock.module("@/runtime/browser", () => ({
  openUrl: async (_url: string) => {},
  openUrlInNewTab: async (_url: string) => {},
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

mock.module("@/hooks/connect-claude-api", () => ({
  startConnectClaude: async () => ({
    mode: "loopback",
    authorize_url: "https://claude.ai/oauth",
    state: "state-abc",
  }),
  pollConnectClaudeStatus: async () => ({ status: "pending" }),
  exchangeConnectClaude: async () => {},
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
  Input: ({ fullWidth: _fullWidth, ...props }: { fullWidth?: boolean }) => (
    <input {...props} />
  ),
}));

mock.module("@vellumai/design-library/components/typography", () => ({
  Typography: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
}));

const { AcpConnectAffordance, toolCallNeedsClaudeConnect } = await import(
  "./acp-connect-affordance"
);

function makeToolCall(overrides: Partial<ChatMessageToolCall>): ChatMessageToolCall {
  return {
    id: "tc-1",
    name: "skill_execute",
    input: { tool: "acp_spawn" },
    ...overrides,
  } as ChatMessageToolCall;
}

beforeEach(() => {
  flagEnabled = true;
});

afterEach(() => {
  cleanup();
});

describe("toolCallNeedsClaudeConnect", () => {
  test("true for a failed acp_spawn carrying the missing-token marker", () => {
    expect(
      toolCallNeedsClaudeConnect(
        makeToolCall({ isError: true, errorCode: "acp_claude_oauth_missing" }),
      ),
    ).toBe(true);
  });

  test("false when the marker is absent", () => {
    expect(
      toolCallNeedsClaudeConnect(
        makeToolCall({ isError: true, errorCode: "some_other_error" }),
      ),
    ).toBe(false);
    expect(
      toolCallNeedsClaudeConnect(makeToolCall({ isError: true })),
    ).toBe(false);
  });

  test("false when the tool call is not an error", () => {
    expect(
      toolCallNeedsClaudeConnect(
        makeToolCall({ isError: false, errorCode: "acp_claude_oauth_missing" }),
      ),
    ).toBe(false);
  });
});

describe("AcpConnectAffordance", () => {
  test("renders the Connect Claude Code button when the flag is on", () => {
    flagEnabled = true;

    render(<AcpConnectAffordance />);

    expect(
      screen.getByRole("button", { name: "Connect Claude Code" }),
    ).not.toBeNull();
  });

  test("renders nothing when the flag is off", () => {
    flagEnabled = false;

    render(<AcpConnectAffordance />);

    expect(
      screen.queryByRole("button", { name: "Connect Claude Code" }),
    ).toBeNull();
    expect(screen.queryByTestId("acp-connect-affordance")).toBeNull();
  });
});
