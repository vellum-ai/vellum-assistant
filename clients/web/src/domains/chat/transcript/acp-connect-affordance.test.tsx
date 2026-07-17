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

import { useInteractionStore } from "@/domains/chat/interaction-store";

let supported = true;
let alreadyConnected = false;
// Whether the plain-web sign-in tab is "pop-up blocked": `openUrlInNewTab`
// resolves `false` in that case (see runtime/browser).
let popupBlocked = false;
// The `mode` the daemon's `start` reports — drives the loopback (one-step) vs
// manual (two-step) card layout once the flow begins.
let startMode: "loopback" | "manual" = "loopback";
// When true, the manual paste exchange rejects (bad/expired code, 400).
let exchangeShouldFail = false;

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
    mode: startMode,
    authorize_url: "https://claude.ai/oauth",
    state: "state-abc",
  }),
  pollConnectClaudeStatus: async () => ({ status: "pending" }),
  exchangeConnectClaude: async () => {
    if (exchangeShouldFail) {
      throw new Error("bad code");
    }
  },
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
  startMode = "loopback";
  exchangeShouldFail = false;
  useInteractionStore.getState().clearAcpContinue();
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

  test("shows the paste step when the daemon returns manual mode (e.g. desktop app on a cloud assistant)", async () => {
    // The desktop app reports isElectron() = true, but a containerized/cloud
    // assistant forces `mode: "manual"`. The card must follow the daemon's mode
    // and render the two-step paste UI — not get stuck in a one-step "waiting"
    // state with no input.
    startMode = "manual";

    render(<AcpConnectAffordance assistantId="assistant-123" />);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    // Once the daemon reports manual, the paste field + Save must appear.
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("Paste your key"),
      ).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
  });

  test("signals auto-continue once the connect flow completes", async () => {
    // The card can't send messages itself, so on reaching `connected` it flips
    // the interaction store's `pendingAcpContinue` flag; the chat view turns
    // that into a hidden continuation send.
    startMode = "manual";

    render(<AcpConnectAffordance assistantId="assistant-123" />);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const input = await screen.findByPlaceholderText("Paste your key");
    fireEvent.change(input, { target: { value: "auth-code-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The exchange resolves → connected → the auto-continue flag is raised.
    await waitFor(() =>
      expect(useInteractionStore.getState().pendingAcpContinue).toBe(true),
    );
  });

  test("surfaces a failed manual paste exchange on the paste step, keeping the input", async () => {
    // A bad/expired/400 code returns to `awaiting_paste` with an error set; the
    // paste step must show it (not silently no-op) and keep the field for retry.
    startMode = "manual";
    exchangeShouldFail = true;

    render(<AcpConnectAffordance assistantId="assistant-123" />);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const input = await screen.findByPlaceholderText("Paste your key");
    fireEvent.change(input, { target: { value: "bad-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The error text appears...
    await screen.findByText(/Couldn't complete Connect Claude/i);
    // ...and the paste field + Save remain for a retry, with the value intact.
    const retryInput = screen.getByPlaceholderText(
      "Paste your key",
    ) as HTMLInputElement;
    expect(retryInput.value).toBe("bad-code");
    expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
  });
});
