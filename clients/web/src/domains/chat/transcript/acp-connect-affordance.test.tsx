/**
 * Tests for the inline "Connect Claude Code" affordance rendered when an
 * `acp_spawn` fails for a missing OAuth token.
 *
 * Covers the version gate and the live-status self-heal: the affordance renders
 * its Connect button when the daemon supports Connect, renders nothing (falling
 * back to the plain error rendering) against a daemon too old to serve the
 * routes, and retires itself when Claude is already connected. Which failed tool
 * call raises the prompt — and its reseed survival — is covered in
 * `acp-connect-prompt.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

let supported = true;
let alreadyConnected = false;

mock.module("@/runtime/browser", () => ({
  openUrl: async (_url: string) => {},
  openUrlInNewTab: async (_url: string) => {},
  openUrlFinishedListener: () => () => {},
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-123",
}));

mock.module("@/lib/backwards-compat/use-supports-acp-connect", () => ({
  useSupportsAcpConnect: () => supported,
}));

mock.module("@/hooks/connect-claude-api", () => ({
  startConnectClaude: async () => ({
    mode: "loopback",
    authorize_url: "https://claude.ai/oauth",
    state: "state-abc",
  }),
  pollConnectClaudeStatus: async () => ({ status: "pending" }),
  exchangeConnectClaude: async () => {},
  isClaudeConnected: async () => alreadyConnected,
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

const { AcpConnectAffordance } = await import("./acp-connect-affordance");

beforeEach(() => {
  supported = true;
  alreadyConnected = false;
});

afterEach(() => {
  cleanup();
});

describe("AcpConnectAffordance", () => {
  test("renders the Connect Claude Code button when the daemon supports Connect", () => {
    supported = true;

    render(<AcpConnectAffordance />);

    expect(
      screen.getByRole("button", { name: "Connect" }),
    ).not.toBeNull();
  });

  test("renders nothing when the daemon is too old to support Connect", () => {
    supported = false;

    render(<AcpConnectAffordance />);

    expect(
      screen.queryByRole("button", { name: "Connect" }),
    ).toBeNull();
    expect(screen.queryByTestId("acp-connect-affordance")).toBeNull();
  });

  test("self-heals: retires the prompt when Claude is already connected", async () => {
    alreadyConnected = true;

    render(<AcpConnectAffordance />);

    // The self-heal check is async; once it resolves as connected the affordance
    // unmounts rather than showing a stale Connect CTA.
    await waitFor(() => {
      expect(screen.queryByTestId("acp-connect-affordance")).toBeNull();
    });
  });
});
