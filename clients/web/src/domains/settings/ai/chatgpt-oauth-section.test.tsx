/**
 * Tests for the ChatGPT subscription sign-in section.
 *
 * Covers the device-code path the section leads with: the code and its
 * destination on screen, the stored connection handed back on success, and a
 * rejection keeping the code visible beside the account-setting hint. The
 * redirect-and-paste path is covered only as far as being reachable behind the
 * disclosure; its own behaviour is unchanged.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import type { PollOutcome } from "@/utils/poll-until-settled";

const ASSISTANT_ID = "asst-1";

const actualApi = await import(
  "@/domains/settings/ai/chatgpt-subscription-api"
);
const { CHATGPT_ACCESS_TOKEN_CREDENTIAL, DeviceAuthUnsupportedError } =
  actualApi;

const STORED_CONNECTION: ProviderConnection = {
  name: "chatgpt-subscription",
  provider: "chatgpt",
  auth: {
    type: "oauth_subscription",
    credential: CHATGPT_ACCESS_TOKEN_CREDENTIAL,
  },
  label: "ChatGPT Subscription",
  baseUrl: null,
  models: null,
  createdAt: 0,
  updatedAt: 0,
  isManaged: false,
};

let startShouldFail = false;
/** The daemon answers the mint route with a 404. */
let startUnsupported = false;
let startCalls = 0;
/** States the section asked the daemon to stop polling. */
let cancelledStates: string[] = [];
/** How the scripted flow settles. `never` leaves it pending on screen. */
let settle: PollOutcome | "never" = { kind: "connected" };

mock.module("@/domains/settings/ai/chatgpt-subscription-api", () => ({
  ...actualApi,
  startChatgptDeviceAuth: async () => {
    startCalls++;
    if (startUnsupported) {
      throw new DeviceAuthUnsupportedError();
    }
    if (startShouldFail) {
      throw new Error("start failed");
    }
    return {
      state: "state-abc",
      userCode: "ABCD-1234",
      verificationUrl: "https://chatgpt.com/device",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      intervalSeconds: 5,
    };
  },
  pollChatgptDeviceAuthStatus: async () => ({ status: "pending" }),
  cancelChatgptDeviceAuth: async (_assistantId: string, state: string) => {
    cancelledStates.push(state);
  },
  resolveChatgptConnection: async () => STORED_CONNECTION,
}));

// The loop's own cadence and budget are covered in
// `utils/poll-until-settled.test.ts`; here it stands in for whichever way the
// flow settled so the section's rendering is what is under test.
mock.module("@/utils/poll-until-settled", () => ({
  pollUntilSettled: (): Promise<PollOutcome> =>
    settle === "never" ? new Promise(() => {}) : Promise.resolve(settle),
}));

const { ChatgptOAuthSection } = await import(
  "@/domains/settings/ai/chatgpt-oauth-section"
);

function renderSection(onConnected: (c: ProviderConnection) => void = () => {}) {
  return render(
    <ChatgptOAuthSection
      assistantId={ASSISTANT_ID}
      onConnected={onConnected}
    />,
  );
}

describe("ChatgptOAuthSection", () => {
  beforeEach(() => {
    startShouldFail = false;
    startUnsupported = false;
    startCalls = 0;
    cancelledStates = [];
    settle = { kind: "connected" };
  });

  afterEach(() => {
    cleanup();
  });

  test("leads with the device-code sign-in and mints nothing until asked", () => {
    renderSection();

    expect(screen.getByText("Sign in with ChatGPT")).toBeDefined();
    expect(screen.queryByText("ABCD-1234")).toBeNull();
    expect(startCalls).toBe(0);
  });

  test("shows the code and its destination once a flow starts", async () => {
    // Left pending so the code stays on screen for the assertions.
    settle = "never";
    renderSection();

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));

    const code = await screen.findByText("ABCD-1234");
    expect(code).toBeDefined();
    const openLink = screen.getByText("Open ChatGPT").closest("a");
    expect(openLink?.getAttribute("href")).toBe("https://chatgpt.com/device");
    expect(openLink?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("hands the stored connection back when the code is authorized", async () => {
    const connected: ProviderConnection[] = [];
    renderSection((c) => connected.push(c));

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));

    await waitFor(() => expect(connected.length).toBe(1));
    expect(connected[0]).toEqual(STORED_CONNECTION);
    expect(
      screen.getByText("ChatGPT subscription connected successfully."),
    ).toBeDefined();
  });

  test("keeps the code beside the account-setting hint on a rejection", async () => {
    settle = { kind: "error", message: "device code authorization disabled" };
    renderSection();

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));

    await screen.findByText("device code authorization disabled");
    expect(screen.getByText("ABCD-1234")).toBeDefined();
    expect(screen.getByText(/enable device code authorization/)).toBeDefined();
    const settingsLink = screen.getByText("in ChatGPT settings").closest("a");
    expect(settingsLink?.getAttribute("href")).toBe(
      "https://chatgpt.com/security-settings",
    );
    expect(screen.getByText("Start over")).toBeDefined();
  });

  test("start over returns to the explainer and stops the daemon's poll", async () => {
    settle = "never";
    renderSection();

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));
    await screen.findByText("ABCD-1234");
    fireEvent.click(screen.getByText("Start over"));

    expect(screen.queryByText("ABCD-1234")).toBeNull();
    expect(screen.getByText("Sign in with ChatGPT")).toBeDefined();
    expect(cancelledStates).toEqual(["state-abc"]);
  });

  test("leaving the page stops the daemon's poll", async () => {
    settle = "never";
    const { unmount } = renderSection();

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));
    await screen.findByText("ABCD-1234");
    unmount();

    expect(cancelledStates).toEqual(["state-abc"]);
  });

  test("opening the other options drops a live code", async () => {
    settle = "never";
    renderSection();

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));
    await screen.findByText("ABCD-1234");

    fireEvent.click(screen.getByText("Other sign-in options"));

    await waitFor(() => expect(screen.queryByText("ABCD-1234")).toBeNull());
    expect(cancelledStates).toEqual(["state-abc"]);
    expect(screen.getByText("Open ChatGPT sign-in")).toBeDefined();
  });

  test("an expired code offers a fresh one and drops the stale one", async () => {
    settle = { kind: "timed_out" };
    renderSection();

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));

    await screen.findByText(
      "This code expired. Start again to get a new one.",
    );
    expect(screen.queryByText("ABCD-1234")).toBeNull();

    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(startCalls).toBe(2));
  });

  test("a failed mint reports it without stranding a code", async () => {
    startShouldFail = true;
    renderSection();

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));

    await screen.findByText(
      "Could not start ChatGPT sign-in. Please try again.",
    );
    expect(screen.queryByText("ABCD-1234")).toBeNull();
    expect(screen.getByText("Try again")).toBeDefined();
  });

  test("hands the section to the paste flow on a daemon without the route", async () => {
    startUnsupported = true;
    renderSection();

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));

    await screen.findByText("Open ChatGPT sign-in");
    expect(screen.queryByText("Sign in with ChatGPT")).toBeNull();
    expect(screen.queryByText("Other sign-in options")).toBeNull();
    expect(
      screen.queryByText("Could not start ChatGPT sign-in. Please try again."),
    ).toBeNull();
  });

  test("the paste flow stays reachable behind the disclosure", () => {
    renderSection();

    expect(screen.queryByText("Open ChatGPT sign-in")).toBeNull();

    fireEvent.click(screen.getByText("Other sign-in options"));

    expect(screen.getByText("Open ChatGPT sign-in")).toBeDefined();
    expect(screen.getByText("Hide other sign-in options")).toBeDefined();
  });
});
