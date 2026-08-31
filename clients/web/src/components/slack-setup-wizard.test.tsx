/**
 * Tests for `SlackSetupWizard`'s step flow:
 *
 *   1. Copying puts the live manifest on the clipboard, carrying what was
 *      typed, and does not navigate.
 *   2. A failed clipboard write neither claims success nor moves the flow on.
 *   3. Navigation is never a side effect of another control: Next advances,
 *      Copy and Open Slack do not.
 *   4. The handoff step reports what this wizard copied, including the stale
 *      case where the app was renamed afterwards, and never claims to know
 *      what the clipboard now holds.
 *   5. An empty app name blocks both controls on step 1.
 *   6. Step 4 hands both tokens to `onSave`, trimmed.
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

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

/**
 * Walk to the token step the way a user does. The wizard exposes no way to
 * start on a later step, so a test that needs one has to earn it: that also
 * means these assertions run against a state the real flow can produce.
 */
function goToConnectStep() {
  fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
  fireEvent.click(screen.getByRole("button", { name: /I created the app/i }));
}

/**
 * The create/token steps render `ChannelAvatarDownload`, which reads the
 * avatar raster from the query cache, so these trees need a client.
 */
function renderWizard(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("SlackSetupWizard step flow", () => {
  test("copying puts the live manifest on the clipboard without navigating", async () => {
    renderWizard(
      <SlackSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
      />,
    );

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
    renderWizard(
      <SlackSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
      />,
    );

    fireEvent.click(copyButton());

    await waitFor(() => {
      expect(toasts).toHaveLength(1);
    });
    // "Copied!" would tell the user to go paste something that isn't there.
    expect(screen.queryByRole("button", { name: /Copied!/i })).toBeNull();
    expect(onOpenStep()).toBe(false);
  });

  test("advancing without a copy warns at the handoff instead of blocking", () => {
    renderWizard(
      <SlackSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
      />,
    );

    fireEvent.click(nextButton());

    expect(clipboardWrites).toHaveLength(0);
    expect(onOpenStep()).toBe(true);
    // Slack's modal cannot fetch the manifest, so the handoff step has to say
    // so rather than let the user paste nothing.
    expect(screen.getByRole("status").textContent).toMatch(
      /have not copied this app's manifest yet/i,
    );
  });

  test("editing after a copy retracts the Copied! label, not just the notice", async () => {
    renderWizard(
      <SlackSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
      />,
    );

    fireEvent.click(copyButton());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Copied!/i })).toBeTruthy();
    });

    // Well inside the 1.5s window the flag survives, so nothing but the
    // manifest comparison can retract the label here. Leaving it would let the
    // notice say "not copied" while the button beside it still says "Copied!".
    fireEvent.change(screen.getByLabelText(/App Name/i), {
      target: { value: "Renamed Bot" },
    });

    expect(screen.queryByRole("button", { name: /Copied!/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Copy manifest/i })).toBeTruthy();
  });

  test("a stale clipboard is reported as not ready", async () => {
    renderWizard(
      <SlackSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
      />,
    );

    fireEvent.click(copyButton());
    await waitFor(() => {
      expect(clipboardWrites).toHaveLength(1);
    });
    // Renaming after copying leaves a manifest on the clipboard that no longer
    // matches the app being created.
    fireEvent.change(screen.getByLabelText(/App Name/i), {
      target: { value: "Renamed Bot" },
    });
    fireEvent.click(nextButton());

    expect(screen.getByRole("status").textContent).toMatch(
      /have not copied this app's manifest yet/i,
    );
    // The notice and the control beside it must not disagree.
    expect(screen.queryByRole("button", { name: /Copied!/i })).toBeNull();
  });

  test("copying at the handoff step marks the manifest copied", async () => {
    renderWizard(
      <SlackSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
      />,
    );

    fireEvent.click(nextButton());
    fireEvent.click(copyButton());

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(
        /you copied this app's manifest here/i,
      );
    });
    // The wizard knows it wrote the manifest, not that the clipboard still
    // holds it, so the notice must not assert the latter.
    expect(screen.getByRole("status").textContent).toMatch(
      /copied anything since, copy it again/i,
    );
    // Copying is still not navigation.
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
      renderWizard(
        <SlackSetupWizard
          assistantId="asst-test"
          assistantName={ASSISTANT_NAME}
        />,
      );
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
    renderWizard(
      <SlackSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
      />,
    );

    fireEvent.change(screen.getByLabelText(/App Name/i), {
      target: { value: "   " },
    });

    expect(copyButton().hasAttribute("disabled")).toBe(true);
    expect(nextButton().hasAttribute("disabled")).toBe(true);

    fireEvent.click(nextButton());
    expect(onOpenStep()).toBe(false);
  });

  test("clears both tokens once the save succeeds", () => {
    // The Channels page keeps this wizard mounted after a successful save, so
    // a retained secret sits in a live field. The chat drawer closes and
    // unmounts, which hides the problem on the surface most people use.
    function Harness() {
      const [status, setStatus] = useState<"idle" | "success">("idle");
      return (
        <SlackSetupWizard
          assistantId="asst-test"
          assistantName={ASSISTANT_NAME}
          saveStatus={status}
          onSave={() => setStatus("success")}
        />
      );
    }
    renderWizard(<Harness />);

    goToConnectStep();
    fireEvent.change(screen.getByLabelText(/Bot Token/i), {
      target: { value: BOT_TOKEN },
    });
    fireEvent.change(screen.getByLabelText(/App Token/i), {
      target: { value: APP_TOKEN },
    });
    fireEvent.click(screen.getByRole("button", { name: /Connect Slack/i }));

    expect(
      (screen.getByLabelText(/Bot Token/i) as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByLabelText(/App Token/i) as HTMLInputElement).value,
    ).toBe("");
  });

  test("step 4 hands both tokens to onSave, trimmed", () => {
    const saved: Array<[string, string]> = [];
    renderWizard(
      <SlackSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
        onSave={(bot, app) => saved.push([bot, app])}
      />,
    );

    goToConnectStep();

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
