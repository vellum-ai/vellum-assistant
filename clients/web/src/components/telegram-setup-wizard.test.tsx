/**
 * Tests for `TelegramSetupWizard`'s step flow:
 *
 *   1. Navigation is never a side effect: Next advances, Open BotFather and
 *      Copy name do not.
 *   2. Token format gates the save, so a wrong-field paste is caught before it
 *      reaches Telegram.
 *   3. The token reaches `onSave` trimmed.
 *
 * All token values are synthetic fixtures.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import * as toastModule from "@vellumai/design-library/components/toast";

// Spread the real module: the design library's barrel re-exports `Toaster` and
// `ToastContent` from here, so a partial mock breaks unrelated imports.
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: { ...toastModule.toast, success: () => {}, error: () => {} },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const { TelegramSetupWizard } = await import(
  "@/components/telegram-setup-wizard"
);

const ASSISTANT_NAME = "Example Assistant";
const BOT_TOKEN = `123456789:${"A".repeat(10)}bCdEfGhIjKlMnOpQrStUvWx`;

let clipboardWrites: string[] = [];

beforeEach(() => {
  clipboardWrites = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return Promise.resolve();
      },
    },
  });
});

afterEach(cleanup);

const onConnectStep = () => screen.queryByLabelText(/Bot Token/i) !== null;
const saveButton = () =>
  screen.getByRole("button", { name: /Connect Telegram/i });

/** Walk to the token step the way a user does; there is no prop to jump. */
function goToConnectStep() {
  fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
}

describe("TelegramSetupWizard step flow", () => {
  test("copying the suggested name does not navigate", () => {
    render(<TelegramSetupWizard assistantName={ASSISTANT_NAME} />);

    fireEvent.click(screen.getByRole("button", { name: /Copy name/i }));

    expect(clipboardWrites).toEqual([ASSISTANT_NAME]);
    expect(onConnectStep()).toBe(false);
  });

  test("opening BotFather opens a tab but does not navigate", () => {
    const opened: string[] = [];
    const realOpen = window.open;
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;

    try {
      render(<TelegramSetupWizard assistantName={ASSISTANT_NAME} />);
      fireEvent.click(screen.getByRole("button", { name: /Open BotFather/i }));

      expect(opened).toEqual(["https://t.me/BotFather"]);
      // A blocked popup would otherwise move the flow past the tab it claims
      // to have opened.
      expect(onConnectStep()).toBe(false);
    } finally {
      window.open = realOpen;
    }
  });

  test("Next advances to the token step", () => {
    render(<TelegramSetupWizard assistantName={ASSISTANT_NAME} />);

    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    expect(onConnectStep()).toBe(true);
  });

  test("a wrong-field paste is rejected before it reaches Telegram", () => {
    const saved: string[] = [];
    render(
      <TelegramSetupWizard
        assistantName={ASSISTANT_NAME}
        onSave={(token) => saved.push(token)}
      />,
    );

    goToConnectStep();

    // A Slack bot token in the Telegram field: the old form would have sent
    // this and surfaced whatever Telegram returned.
    fireEvent.change(screen.getByLabelText(/Bot Token/i), {
      target: { value: "xoxb-0000000000-0000000000-abcdef" },
    });

    expect(saveButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(saveButton());
    expect(saved).toEqual([]);
  });

  test("a truncated token is rejected", () => {
    render(<TelegramSetupWizard assistantName={ASSISTANT_NAME} />);

    goToConnectStep();

    fireEvent.change(screen.getByLabelText(/Bot Token/i), {
      target: { value: "123456789:AAHkO1Qb" },
    });

    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  test("clears the token once the save succeeds", () => {
    // Neither surface unmounts this wizard on success, and the Channels page
    // keeps it mounted while readiness catches up, so a retained secret sits
    // in a live field for as long as that takes.
    function Harness() {
      const [status, setStatus] = useState<"idle" | "success">("idle");
      return (
        <>
          <TelegramSetupWizard
            assistantName={ASSISTANT_NAME}
            saveStatus={status}
            onSave={() => setStatus("success")}
          />
          <span data-testid="status">{status}</span>
        </>
      );
    }
    render(<Harness />);

    goToConnectStep();
    const field = screen.getByLabelText(/Bot Token/i) as HTMLInputElement;
    fireEvent.change(field, { target: { value: BOT_TOKEN } });
    expect(field.value).toBe(BOT_TOKEN);

    fireEvent.click(saveButton());

    expect(
      (screen.getByLabelText(/Bot Token/i) as HTMLInputElement).value,
    ).toBe("");
  });

  test("a well-formed token reaches onSave, trimmed", () => {
    const saved: string[] = [];
    render(
      <TelegramSetupWizard
        assistantName={ASSISTANT_NAME}
        onSave={(token) => saved.push(token)}
      />,
    );

    goToConnectStep();

    fireEvent.change(screen.getByLabelText(/Bot Token/i), {
      target: { value: `  ${BOT_TOKEN}  ` },
    });
    fireEvent.click(saveButton());

    expect(saved).toEqual([BOT_TOKEN]);
  });
});
