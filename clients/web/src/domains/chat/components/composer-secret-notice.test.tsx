/**
 * Tests for `ComposerSecretNotice` — masked display, generic copy, and
 * dismissal in the passive state, plus the blocked-send state's exact copy
 * and "Send anyway" / "Dismiss" actions, and the "Store securely" action
 * offered in both states. The token is a synthetic value invented for
 * these tests.
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

const BLOCKED_TITLE = "Message not sent. It looks like it contains an API key.";

function renderNotice(overrides: Partial<ComposerSecretNoticeProps> = {}) {
  // Default the composer input to one that CONTAINS the previewed secret, so
  // "Store securely" is offered wherever the match itself is storable — the
  // input-origin case. Tests that exercise a quote/path-reference-originated
  // secret pass a `composerInput` that omits the value.
  const firstValue = (overrides.matches?.[0] ?? match).value;
  return render(
    <ComposerSecretNotice
      matches={[match]}
      composerInput={`here is ${firstValue} for the deploy`}
      sendBlocked={false}
      onDismiss={() => {}}
      onSendAnyway={() => {}}
      onStoreSecurely={() => {}}
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
      "Credentials sent in chat are visible in the transcript. Store it securely instead.",
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

  test("Store securely action is offered and invokes onStoreSecurely", () => {
    const onStoreSecurely = mock(() => {});
    renderNotice({ onStoreSecurely });
    fireEvent.click(screen.getByRole("button", { name: "Store securely" }));
    expect(onStoreSecurely).toHaveBeenCalledTimes(1);
  });
});

describe("ComposerSecretNotice (non-storable match)", () => {
  // A private key detected by its header alone — the END footer never
  // arrived, so storing would leave the key body in the draft.
  const headerOnlyPem: DetectedSecret = {
    label: "Private Key",
    value: "-----BEGIN RSA PRIVATE KEY-----",
    start: 0,
    end: "-----BEGIN RSA PRIVATE KEY-----".length,
    wholeMessage: false,
  };

  test("passive state omits Store securely for a header-only private key", () => {
    renderNotice({ matches: [headerOnlyPem] });
    expect(screen.queryByRole("button", { name: "Store securely" })).toBeNull();
  });

  test("blocked state omits Store securely but keeps Send anyway / Dismiss", () => {
    renderNotice({ matches: [headerOnlyPem], sendBlocked: true });
    expect(screen.queryByRole("button", { name: "Store securely" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send anyway" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  test("a complete PEM block still offers Store securely", () => {
    const fullBlock: DetectedSecret = {
      label: "Private Key",
      value:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEfakefakefake==\n-----END RSA PRIVATE KEY-----",
      start: 0,
      end: 92,
      wholeMessage: false,
    };
    renderNotice({ matches: [fullBlock] });
    expect(screen.getByRole("button", { name: "Store securely" })).toBeTruthy();
  });
});

describe("ComposerSecretNotice (secret outside the raw input)", () => {
  // The pre-send gate scans the assembled outgoing content (staged quote text
  // + appended path references + input), so a secret can be flagged while
  // living ONLY in a quote or a path reference, never in the raw composer
  // input. "Store securely" rewrites only `input`, so offering it here would
  // fire a "Stored securely" toast while the untouched secret still rides the
  // follow-up "Send anyway" — a false success. The action must be suppressed.
  const QUOTE_ONLY_INPUT = "please rotate this — see the quote above";

  test("passive state omits Store securely when the secret isn't in the input", () => {
    renderNotice({ composerInput: QUOTE_ONLY_INPUT });
    expect(screen.queryByRole("button", { name: "Store securely" })).toBeNull();
  });

  test("blocked state omits Store securely but keeps Send anyway / Dismiss", () => {
    renderNotice({ composerInput: QUOTE_ONLY_INPUT, sendBlocked: true });
    expect(screen.queryByRole("button", { name: "Store securely" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send anyway" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  test("the same secret IS offered Store securely once it's present in the input", () => {
    // Control: identical match, input that contains the value → offered.
    renderNotice({ composerInput: `here is ${SYNTHETIC_PROJECT_KEY} inline` });
    expect(screen.getByRole("button", { name: "Store securely" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Send anyway" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Store securely" })).toBeTruthy();
  });

  test("Store securely action invokes onStoreSecurely while blocked", () => {
    const onStoreSecurely = mock(() => {});
    renderNotice({ sendBlocked: true, onStoreSecurely });
    fireEvent.click(screen.getByRole("button", { name: "Store securely" }));
    expect(onStoreSecurely).toHaveBeenCalledTimes(1);
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
