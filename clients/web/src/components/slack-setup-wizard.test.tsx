/**
 * Tests for `SlackSetupWizard`'s step flow:
 *
 *   1. Copying puts the live manifest on the clipboard, carrying what was
 *      typed, and does not navigate.
 *   2. A failed clipboard write neither claims success nor moves the flow on.
 *   3. Navigation is never a side effect of another control: Next advances,
 *      Copy and Open Slack do not.
 *   4. An empty app name blocks both controls on step 1.
 *   5. Step 4 hands both tokens to `onSave`, trimmed.
 *
 * All token values are synthetic fixtures.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import * as toastModule from "@vellumai/design-library/components/toast";

const toasts: string[] = [];
// Spread the real module: the design library's barrel re-exports `Toaster` and
// `ToastContent` from here, so a partial mock breaks unrelated imports.
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: {
    ...toastModule.toast,
    success: () => {},
    error: (message: string) => {
      toasts.push(message);
    },
  },
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const { SlackSetupWizard } = await import("@/components/slack-setup-wizard");

const ASSISTANT_NAME = "Example Assistant";
const DIGITS = "0".repeat(10);
const BOT_TOKEN = `xoxb-${DIGITS}-${DIGITS}-abcdefghij`;
const APP_TOKEN = `xapp-1-A${DIGITS}-${DIGITS}-abcdefghij`;

let clipboardWrites: string[] = [];

function stubClipboard(result: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return result();
      },
    },
  });
}

beforeEach(() => {
  clipboardWrites = [];
  toasts.length = 0;
  stubClipboard(() => Promise.resolve());
});

afterEach(cleanup);

const copyButton = () =>
  screen.getByRole("button", { name: /Copy manifest|Copied!/i });
const nextButton = () => screen.getByRole("button", { name: /^Next$/i });
const onOpenStep = () =>
  screen.queryByRole("button", { name: /Open Slack/i }) !== null;

describe("SlackSetupWizard step flow", () => {
  test("copying puts the live manifest on the clipboard without navigating", async () => {
    render(<SlackSetupWizard assistantName={ASSISTANT_NAME} />);

    fireEvent.change(screen.getByLabelText(/App Name/i), {
      target: { value: "Support Bot" },
    });
    fireEvent.click(copyButton());

    // The edited name proves this is the live manifest, not a stale render.
    expect(clipboardWrites).toHaveLength(1);
    expect(JSON.parse(clipboardWrites[0]).display_information.name).toBe(
      "Support Bot",
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Copied!/i })).toBeTruthy();
    });
    expect(onOpenStep()).toBe(false);
  });

  test("a failed clipboard write neither claims success nor advances", async () => {
    stubClipboard(() => Promise.reject(new Error("NotAllowedError")));
    render(<SlackSetupWizard assistantName={ASSISTANT_NAME} />);

    fireEvent.click(copyButton());

    await waitFor(() => {
      expect(toasts).toHaveLength(1);
    });
    // "Copied!" would tell the user to go paste something that isn't there.
    expect(screen.queryByRole("button", { name: /Copied!/i })).toBeNull();
    expect(onOpenStep()).toBe(false);
  });

  test("Next advances without requiring a copy", () => {
    render(<SlackSetupWizard assistantName={ASSISTANT_NAME} />);

    fireEvent.click(nextButton());

    expect(clipboardWrites).toHaveLength(0);
    expect(onOpenStep()).toBe(true);
  });

  test("opening Slack opens a tab but does not navigate the wizard", () => {
    const opened: string[] = [];
    const realOpen = window.open;
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;

    try {
      render(<SlackSetupWizard assistantName={ASSISTANT_NAME} />);
      fireEvent.click(nextButton());
      fireEvent.click(screen.getByRole("button", { name: /Open Slack/i }));

      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain("api.slack.com/apps");

      // A blocked popup would otherwise move the flow past the tab it claims
      // to have opened.
      expect(onOpenStep()).toBe(true);
      expect(
        screen.queryByRole("button", { name: /I created the app/i }),
      ).toBeNull();
    } finally {
      window.open = realOpen;
    }
  });

  test("an empty app name blocks both controls on step 1", () => {
    render(<SlackSetupWizard assistantName={ASSISTANT_NAME} />);

    fireEvent.change(screen.getByLabelText(/App Name/i), {
      target: { value: "   " },
    });

    expect(copyButton().hasAttribute("disabled")).toBe(true);
    expect(nextButton().hasAttribute("disabled")).toBe(true);

    fireEvent.click(nextButton());
    expect(onOpenStep()).toBe(false);
  });

  test("step 4 hands both tokens to onSave, trimmed", () => {
    const saved: Array<[string, string]> = [];
    render(
      <SlackSetupWizard
        assistantName={ASSISTANT_NAME}
        initialStepId="connect"
        onSave={(bot, app) => saved.push([bot, app])}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Bot Token/i), {
      target: { value: `  ${BOT_TOKEN}  ` },
    });
    fireEvent.change(screen.getByLabelText(/App Token/i), {
      target: { value: APP_TOKEN },
    });
    fireEvent.click(screen.getByRole("button", { name: /Connect Slack/i }));

    expect(saved).toEqual([[BOT_TOKEN, APP_TOKEN]]);
  });
});
