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
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
const { channelverificationsessionsStatusGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");

const INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=000000000000000001";
const ASSISTANT_NAME = "Example Assistant";

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

afterEach(() => {
  openedUrls = [];
  cleanup();
});

/**
 * The create step renders `ChannelAvatarDownload`, which reads the avatar
 * raster from the query cache, so these trees need a client. Callers that
 * need cache state (the guardian binding) seed via `prepare`.
 */
function renderWizard(
  ui: React.ReactElement,
  prepare?: (client: QueryClient) => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  prepare?.(client);
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
      assistantName={ASSISTANT_NAME}
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
const verifyHandoffShown = () =>
  screen.queryByText(/verify me on Discord/i) !== null;

/** Walk to the invite step the way a user does; there is no prop to jump. */
function goToInviteStep() {
  fireEvent.click(screen.getByRole("button", { name: /I have my token/i }));
  fireEvent.change(screen.getByLabelText(/Bot token/i), {
    target: { value: "test-bot-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
}

describe("DiscordSetupWizard completion handoff", () => {
  test("copying the suggested app name does not navigate", () => {
    renderWizard(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: /Copy name/i }));

    expect(clipboardWrites).toEqual([ASSISTANT_NAME]);
    expect(screen.queryByLabelText(/Bot token/i)).toBeNull();
  });

  test("the connect step says the portal's App Verification can be ignored", () => {
    renderWizard(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /I have my token/i }));

    // The call-out that keeps the portal's "missing 4 criteria" page from
    // reading as a required step this wizard forgot. It sits on the token
    // step because that is where the user lands right after meeting it.
    expect(screen.queryByText(/Verify your App/)).not.toBeNull();
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
    expect(verifyHandoffShown()).toBe(true);
  });

  test("opening the invite link opens Discord but does not complete the wizard", () => {
    renderWizard(<Harness />);
    goToInviteStep();

    fireEvent.click(openInviteButton());

    expect(openedUrls).toEqual([INVITE_URL]);
    // Authorization happens in a Discord popup this app cannot observe, so
    // only the user's own confirmation may complete the flow.
    expect(verifyHandoffShown()).toBe(false);
    expect(confirmJoinedButton()).not.toBeNull();
  });

  test("an already-verified account is not told to verify again", () => {
    // Disconnecting Discord clears only the credential, so a reconnecting
    // guardian can still hold a verified binding. Seeded rather than fetched:
    // the binding status is read through TanStack Query, and a test owns the
    // cache.
    renderWizard(<Harness />, (client) => {
      client.setQueryData(
        channelverificationsessionsStatusGetQueryKey({
          path: { assistant_id: "asst-test" },
          query: { channel: "discord" },
        }),
        { success: true, bound: true },
      );
    });
    goToInviteStep();

    fireEvent.click(confirmJoinedButton());

    expect(screen.queryByText(/You're verified/i)).not.toBeNull();
    expect(verifyHandoffShown()).toBe(false);
  });

  test("Verify me hands verification to the assistant", () => {
    // The chat drawer offers the handoff button; the typed-phrase fallback
    // only appears on surfaces with no conversation to signal.
    let verifyRequests = 0;
    renderWizard(
      <DiscordSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
        saveStatus="success"
        inviteUrl={INVITE_URL}
        onVerifyRequest={() => {
          verifyRequests += 1;
        }}
      />,
    );

    fireEvent.click(confirmJoinedButton());
    expect(verifyHandoffShown()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Verify me/i }));
    expect(verifyRequests).toBe(1);
  });

  test("without an invite URL there is nothing to confirm", () => {
    renderWizard(
      <DiscordSetupWizard
        assistantId="asst-test"
        assistantName={ASSISTANT_NAME}
        saveStatus="success"
      />,
    );

    expect(
      screen.queryByRole("button", { name: /I've added the bot/i }),
    ).toBeNull();
    expect(verifyHandoffShown()).toBe(false);
  });
});
