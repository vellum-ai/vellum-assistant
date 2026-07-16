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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

let supported = true;
let alreadyConnected = false;
// Whether the plain-web sign-in tab is "pop-up blocked": `openUrlInNewTab`
// resolves `false` in that case (see runtime/browser).
let popupBlocked = false;

mock.module("@/runtime/browser", () => ({
  openUrl: async (_url: string) => {},
  openUrlInNewTab: async (_url: string) => !popupBlocked,
  openUrlFinishedListener: () => () => {},
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
    fullWidth: _fullWidth,
    ...props
  }: {
    children?: ReactNode;
    size?: string;
    variant?: string;
    fullWidth?: boolean;
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
  popupBlocked = false;
});

afterEach(() => {
  cleanup();
});

describe("AcpConnectAffordance", () => {
  test("renders the Connect Claude Code button when the daemon supports Connect", () => {
    supported = true;

    render(<AcpConnectAffordance assistantId="assistant-123" />);

    expect(
      screen.getByRole("button", { name: "Connect" }),
    ).not.toBeNull();
  });

  test("renders nothing when the daemon is too old to support Connect", () => {
    supported = false;

    render(<AcpConnectAffordance assistantId="assistant-123" />);

    expect(
      screen.queryByRole("button", { name: "Connect" }),
    ).toBeNull();
    expect(screen.queryByTestId("acp-connect-affordance")).toBeNull();
  });

  test("renders nothing when there is no active assistant id", () => {
    supported = true;

    render(<AcpConnectAffordance assistantId={null} />);

    // No active assistant → nothing to connect against, and never calls the
    // active-assistant hook that throws outside ActiveAssistantGate.
    expect(screen.queryByTestId("acp-connect-affordance")).toBeNull();
  });

  test("self-heals: retires the prompt when Claude is already connected", async () => {
    alreadyConnected = true;

    render(<AcpConnectAffordance assistantId="assistant-123" />);

    // The self-heal check is async; once it resolves as connected the affordance
    // unmounts rather than showing a stale Connect CTA.
    await waitFor(() => {
      expect(screen.queryByTestId("acp-connect-affordance")).toBeNull();
    });
  });

  test("opens the sign-in tab and advances to awaiting-capture", async () => {
    render(<AcpConnectAffordance assistantId="assistant-123" />);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    // The pop-up opened, so the loopback flow advances to its waiting state.
    await waitFor(() =>
      expect(screen.getByText(/Waiting for Claude sign-in/)).not.toBeNull(),
    );
  });

  test("surfaces a retry when the sign-in pop-up is blocked", async () => {
    popupBlocked = true;

    render(<AcpConnectAffordance assistantId="assistant-123" />);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    // A blocked pop-up must not silently advance to a wait; show an actionable
    // error and keep the Connect button available for a retry.
    await waitFor(() =>
      expect(screen.getByText(/blocked the sign-in tab/)).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Connect" })).not.toBeNull();
  });
});
