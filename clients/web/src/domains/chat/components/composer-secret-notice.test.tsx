/**
 * Tests for `ComposerSecretNotice` — masked display, generic copy, and
 * dismissal. The token is a synthetic value invented for these tests.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { DetectedSecret } from "@vellumai/service-contracts/secret-detection";

import {
  ComposerSecretNotice,
  maskSecretValue,
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

describe("ComposerSecretNotice", () => {
  test("renders the masked value — the full plaintext never reaches the DOM", () => {
    const { container } = render(
      <ComposerSecretNotice matches={[match]} onDismiss={() => {}} />,
    );
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
  });

  test("dismiss control invokes onDismiss", () => {
    const onDismiss = mock(() => {});
    render(<ComposerSecretNotice matches={[match]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("renders nothing without matches", () => {
    const { container } = render(
      <ComposerSecretNotice matches={[]} onDismiss={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
