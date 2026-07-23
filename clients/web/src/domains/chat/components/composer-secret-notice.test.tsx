/**
 * Tests for `ComposerSecretNotice` — masked display, generic copy, and
 * dismissal in the passive state, plus the blocked-send state's exact copy
 * and "Send anyway" / "Dismiss" actions. The token is a synthetic value
 * invented for these tests.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { DetectedSecret } from "@vellumai/service-contracts/secret-detection";

import {
  ComposerSecretNotice,
  maskSecretValue,
  type ComposerSecretNoticeProps,
} from "./composer-secret-notice";

const SYNTHETIC_PROJECT_KEY =
  "sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3A";

const match: DetectedSecret = {
  label: "OpenAI Project Key",
  value: SYNTHETIC_PROJECT_KEY,
  start: 0,
  end: SYNTHETIC_PROJECT_KEY.length,
  wholeMessage: false,
};

const BLOCKED_TITLE =
  "Message not sent — it looks like it contains an API key";

function renderNotice(overrides: Partial<ComposerSecretNoticeProps> = {}) {
  return render(
    <ComposerSecretNotice
      matches={[match]}
      sendBlocked={false}
      onDismiss={() => {}}
      onSendAnyway={() => {}}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("maskSecretValue", () => {
  test("keeps a short head and masks the rest", () => {
    const masked = maskSecretValue(SYNTHETIC_PROJECT_KEY);
    expect(masked).toBe("sk-pro••••••••");
    expect(masked).not.toContain(SYNTHETIC_PROJECT_KEY);
  });
});

describe("ComposerSecretNotice (passive)", () => {
  test("renders the masked value — the full plaintext never reaches the DOM", () => {
    const { container } = renderNotice();
    expect(container.textContent).toContain("This looks like an API key");
    expect(container.textContent).toContain(
      maskSecretValue(SYNTHETIC_PROJECT_KEY),
    );
    expect(container.textContent).toContain(
      "Credentials sent in chat are visible in the transcript — store it securely instead.",
    );
    expect(container.innerHTML).not.toContain(SYNTHETIC_PROJECT_KEY);
    // The detection label (vendor) stays internal.
    expect(container.textContent).not.toContain("OpenAI");
    // Blocked-state affordances are absent while passive.
    expect(container.textContent).not.toContain(BLOCKED_TITLE);
    expect(screen.queryByRole("button", { name: "Send anyway" })).toBeNull();
  });

  test("dismiss control invokes onDismiss", () => {
    const onDismiss = mock(() => {});
    renderNotice({ onDismiss });
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("renders nothing without matches", () => {
    const { container } = renderNotice({ matches: [] });
    expect(container.innerHTML).toBe("");
  });
});

describe("ComposerSecretNotice (blocked send)", () => {
  test("shows the exact blocked copy, the masked value, and both actions", () => {
    const { container } = renderNotice({ sendBlocked: true });
    expect(container.textContent).toContain(BLOCKED_TITLE);
    expect(container.textContent).toContain(
      maskSecretValue(SYNTHETIC_PROJECT_KEY),
    );
    expect(container.innerHTML).not.toContain(SYNTHETIC_PROJECT_KEY);
    // Copy stays generic — never names the detected vendor.
    expect(container.textContent).not.toContain("OpenAI");
    expect(
      screen.getByRole("button", { name: "Send anyway" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  test("Send anyway invokes the bypass-and-resubmit handler once", () => {
    // The handler is the orchestrator's composition of allowOnce() +
    // submitMessage(); the component just fires it.
    const onSendAnyway = mock(() => {});
    renderNotice({ sendBlocked: true, onSendAnyway });
    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(onSendAnyway).toHaveBeenCalledTimes(1);
  });

  test("Dismiss action invokes onDismiss", () => {
    const onDismiss = mock(() => {});
    renderNotice({ sendBlocked: true, onDismiss });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
