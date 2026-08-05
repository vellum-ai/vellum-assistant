/**
 * Tests for `SlackSetupWizard`'s step flow:
 *
 *   1. Copy and advance are one action, and the manifest that reaches the
 *      clipboard carries what was typed on step 1.
 *   2. Step 1 offers no second way forward. Slack's create-app modal cannot
 *      fetch the manifest, so a path to step 2 that skips the copy would
 *      strand the user with nothing to paste.
 *   3. An empty app name blocks the only control that advances.
 *   4. Step 3 hands both tokens to `onSave`, trimmed.
 *
 * All token values are synthetic fixtures.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { SlackSetupWizard } from "@/components/slack-setup-wizard";

const ASSISTANT_NAME = "Example Assistant";
const DIGITS = "0".repeat(10);
const BOT_TOKEN = `xoxb-${DIGITS}-${DIGITS}-abcdefghij`;
const APP_TOKEN = `xapp-1-A${DIGITS}-${DIGITS}-abcdefghij`;

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

function continueButton() {
  return screen.getByRole("button", { name: /Copy manifest and continue/i });
}

describe("SlackSetupWizard step flow", () => {
  test("copying the manifest is what advances to step 2", async () => {
    render(<SlackSetupWizard assistantName={ASSISTANT_NAME} />);

    fireEvent.change(screen.getByLabelText(/App Name/i), {
      target: { value: "Support Bot" },
    });
    fireEvent.click(continueButton());

    // The clipboard carries the edited name, not the assistant's default, so
    // this proves the live manifest was copied rather than a stale render.
    expect(clipboardWrites).toHaveLength(1);
    expect(JSON.parse(clipboardWrites[0]).display_information.name).toBe(
      "Support Bot",
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open Slack/i })).toBeTruthy();
    });
  });

  test("step 1 offers no way forward that skips the copy", () => {
    render(<SlackSetupWizard assistantName={ASSISTANT_NAME} />);

    // Counted rather than probed by name: a bare "Next" or "Skip" added later
    // would reach step 2 with an empty clipboard, and Slack's modal has
    // nowhere to fetch the manifest from.
    const panel = document.querySelector('[data-slot="slack-setup-step-panel"]');
    const stepButtons = panel!.querySelectorAll("button");
    expect(stepButtons).toHaveLength(1);
    expect(stepButtons[0].textContent).toMatch(/Copy manifest and continue/i);
  });

  test("an empty app name blocks the only control that advances", () => {
    render(<SlackSetupWizard assistantName={ASSISTANT_NAME} />);

    fireEvent.change(screen.getByLabelText(/App Name/i), {
      target: { value: "   " },
    });

    expect(continueButton().hasAttribute("disabled")).toBe(true);

    fireEvent.click(continueButton());
    expect(clipboardWrites).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Open Slack/i })).toBeNull();
  });

  test("step 3 hands both tokens to onSave, trimmed", () => {
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
