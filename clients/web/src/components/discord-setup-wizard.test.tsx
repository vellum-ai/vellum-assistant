/**
 * Tests for `DiscordSetupWizard`'s completion handoff:
 *
 *   1. Confirming the bot joined is what completes the wizard: the invite
 *      step's confirm action moves to the finish step, which shows the
 *      connected-but-not-verified handoff instead of the invite button.
 *   2. Opening the invite link alone never completes the wizard, because
 *      Discord authorizes in a popup this app cannot observe.
 *   3. The create step defuses the portal's App Verification page up front.
 *
 * All token values are synthetic fixtures.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import * as toastModule from "@vellumai/design-library/components/toast";

// Spread the real module: the design library's barrel re-exports `Toaster` and
// `ToastContent` from here, so a partial mock breaks unrelated imports.
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: { ...toastModule.toast, success: () => {}, error: () => {} },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));

const browserModule = await import("@/runtime/browser");
let openedUrls: string[] = [];
mock.module("@/runtime/browser", () => ({
  ...browserModule,
  openExternalUrl: (url: string) => {
    openedUrls.push(url);
    return Promise.resolve();
  },
}));

const { DiscordSetupWizard } =
  await import("@/components/discord-setup-wizard");

const INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=000000000000000001";

afterEach(() => {
  openedUrls = [];
  cleanup();
});

/**
 * The create step renders `ChannelAvatarDownload`, which reads the avatar
 * raster from the query cache, so these trees need a client.
 */
function renderWizard(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/**
 * Drives the wizard the way its parents do: `onSave` flips the status to
 * success, which is what advances the wizard to the invite step.
 */
function Harness() {
  const [status, setStatus] = useState<"idle" | "success">("idle");
  return (
    <DiscordSetupWizard
      assistantId="asst-test"
      saveStatus={status}
      onSave={() => setStatus("success")}
      inviteUrl={INVITE_URL}
    />
  );
}

const confirmJoinedButton = () =>
  screen.getByRole("button", { name: /I've added the bot/i });
const openInviteButton = () =>
  screen.getByRole("button", { name: /Add to a server/i });
const onFinishStep = () => screen.queryByText(/verify me on Discord/i) !== null;

/** Walk to the invite step the way a user does; there is no prop to jump. */
function goToInviteStep() {
  fireEvent.click(screen.getByRole("button", { name: /I have my token/i }));
  fireEvent.change(screen.getByLabelText(/Bot token/i), {
    target: { value: "test-bot-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
}

describe("DiscordSetupWizard completion handoff", () => {
  test("the create step says the portal's App Verification can be ignored", () => {
    renderWizard(<Harness />);

    // The one line that keeps the portal's "missing 4 criteria" page from
    // reading as a required step this wizard forgot.
    expect(screen.queryByText(/App Verification/)).not.toBeNull();
    expect(screen.queryByText(/100 servers/)).not.toBeNull();
  });

  test("confirming the bot joined completes the wizard with the verification handoff", () => {
    renderWizard(<Harness />);
    goToInviteStep();

    fireEvent.click(confirmJoinedButton());

    // The wizard visibly completes: the invite button is gone, and the
    // closing state pairs the success with the unverified-identity handoff.
    expect(
      screen.queryByRole("button", { name: /Add to a server/i }),
    ).toBeNull();
    expect(screen.queryByText(/Bot added/i)).not.toBeNull();
    expect(onFinishStep()).toBe(true);
  });

  test("opening the invite link opens Discord but does not complete the wizard", () => {
    renderWizard(<Harness />);
    goToInviteStep();

    fireEvent.click(openInviteButton());

    expect(openedUrls).toEqual([INVITE_URL]);
    // Authorization happens in a Discord popup this app cannot observe, so
    // only the user's own confirmation may complete the flow.
    expect(onFinishStep()).toBe(false);
    expect(confirmJoinedButton()).not.toBeNull();
  });

  test("without an invite URL there is nothing to confirm", () => {
    renderWizard(
      <DiscordSetupWizard assistantId="asst-test" saveStatus="success" />,
    );

    expect(
      screen.queryByRole("button", { name: /I've added the bot/i }),
    ).toBeNull();
    expect(onFinishStep()).toBe(false);
  });
});
