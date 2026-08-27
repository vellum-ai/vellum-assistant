/**
 * Tests for the ChatGPT subscription sign-in section.
 *
 * With `chatgpt-device-code-login` on, covers the device-code path the section
 * leads with: the code and its destination on screen, the stored connection
 * handed back on success, and a rejection keeping the code visible beside the
 * account-setting hint. The redirect-and-paste path is covered as far as being
 * reachable behind the disclosure and taking the section over once it signs
 * in; its own behaviour is unchanged.
 *
 * With the flag off, covers that redirect-and-paste is the whole section: no
 * code is minted, no disclosure is offered, the flow wears the plain sign-in
 * name rather than the one it narrows to beside the device code, and a value
 * landing after mount leaves that section as it is.
 *
 * Both arms cover the step every sign-in ends on: a default provider that
 * cannot serve a turn is switched to the new subscription without asking, a
 * working one is left alone behind a button, and the caches the switch
 * invalidates.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  DefaultProviderStatus,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
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

/** The default provider as the daemon reports it before the sign-in. */
let defaultProviderState: DefaultProviderStatus = {
  provider: "anthropic",
  resolvedConnectionName: "anthropic-personal",
  availability: { status: "ok" },
};
/** Bodies the section PUT to the default-provider route. */
let putBodies: Array<{ provider: string; connectionName?: string }> = [];
let putShouldFail = false;
/** `_id` of every query key the section asked to invalidate. */
let invalidatedQueryIds: string[] = [];
let toastErrors: string[] = [];

let startShouldFail = false;
/** The daemon answers the mint route with a 404. */
let startUnsupported = false;
let startCalls = 0;
/** States the section asked the daemon to stop polling. */
let cancelledStates: string[] = [];
/** How the scripted flow settles. `never` leaves it pending on screen. */
let settle: PollOutcome | "never" = { kind: "connected" };

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const actualSdk = await import("@/generated/daemon/sdk.gen");

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  configLlmDefaultproviderGet: async () => ({ data: defaultProviderState }),
  configLlmDefaultproviderPut: async (options?: {
    body?: { provider: string; connectionName?: string };
  }) => {
    if (putShouldFail) {
      throw new Error("put failed");
    }
    if (options?.body) {
      putBodies.push(options.body);
    }
    return { data: defaultProviderState, response: { ok: true } };
  },
  inferenceChatgptsubscriptionAuthPost: async () => ({
    data: { authorize_url: "https://auth.openai.com/authorize" },
  }),
  inferenceChatgptsubscriptionAuthExchangePost: async () => ({ data: {} }),
}));

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

const { useClientFeatureFlagStore } = await import(
  "@/stores/client-feature-flag-store"
);

const { ChatgptOAuthSection } = await import(
  "@/domains/settings/ai/chatgpt-oauth-section"
);
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);

// The paste flow opens OpenAI's authorize page in a second tab. There is no
// tab to open here, and the flow's own state is what is under test.
window.open = () => null;

/**
 * A client per render, with `invalidateQueries` recording what it was asked
 * to refresh: the live-refresh contract of this step is which caches it
 * marks stale, not what the daemon then answers.
 */
function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = (filters, options) => {
    const key = (filters as { queryKey?: Array<{ _id?: string }> } | undefined)
      ?.queryKey;
    const id = key?.[0]?._id;
    if (id) {
      invalidatedQueryIds.push(id);
    }
    return invalidate(filters, options);
  };
  return createElement(QueryClientProvider, { client }, children);
}

function setDeviceCodeLoginFlag(value: boolean) {
  useClientFeatureFlagStore.setState({ chatgptDeviceCodeLogin: value });
}

function resetState() {
  startShouldFail = false;
  startUnsupported = false;
  startCalls = 0;
  cancelledStates = [];
  settle = { kind: "connected" };
  defaultProviderState = {
    provider: "anthropic",
    resolvedConnectionName: "anthropic-personal",
    availability: { status: "ok" },
  };
  putBodies = [];
  putShouldFail = false;
  invalidatedQueryIds = [];
  toastErrors = [];
  useAssistantIdentityStore.getState().setIdentity("test-asst", "0.11.0");
}

function renderSection(onConnected: (c: ProviderConnection) => void = () => {}) {
  return render(
    <Wrapper>
      <ChatgptOAuthSection
        assistantId={ASSISTANT_ID}
        onConnected={onConnected}
      />
    </Wrapper>,
  );
}

function signIn() {
  fireEvent.click(screen.getByText("Sign in with ChatGPT"));
}

/**
 * Drives the redirect-and-paste flow from its button to a stored credential.
 * Both clicks settle a promise the flow renders from, so each is awaited
 * inside `act` rather than leaving the update to land after the assertion.
 */
async function completePasteSignIn(signInLabel: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(signInLabel));
  });
  fireEvent.change(screen.getByPlaceholderText("Paste callback URL here..."), {
    target: { value: "https://example.com/callback?code=code-1&state=state-1" },
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Complete Sign In"));
  });
}

describe("ChatgptOAuthSection with device-code login on", () => {
  beforeEach(() => {
    resetState();
    setDeviceCodeLoginFlag(true);
  });

  afterEach(() => {
    cleanup();
    useAssistantIdentityStore.getState().clearIdentity();
    setDeviceCodeLoginFlag(false);
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

  test("hands the stored connection back once the step is done with it", async () => {
    const connected: ProviderConnection[] = [];
    renderSection((c) => connected.push(c));

    signIn();

    // The working default keeps the step on screen, so the host is not told
    // (and the editor does not close) until the user is finished with it.
    const done = await screen.findByText("Done");
    expect(
      screen.getByText("ChatGPT subscription connected successfully."),
    ).toBeDefined();
    expect(connected.length).toBe(0);

    fireEvent.click(done);

    expect(connected).toEqual([STORED_CONNECTION]);
  });

  test("a default that cannot serve a turn is switched without asking", async () => {
    defaultProviderState = {
      provider: "anthropic",
      resolvedConnectionName: "anthropic-personal",
      availability: {
        status: "missing_credential",
        message:
          'Connection "anthropic-personal" has no API key stored. Add one.',
      },
    };
    const connected: ProviderConnection[] = [];
    renderSection((c) => connected.push(c));

    signIn();

    expect(
      await screen.findByText("ChatGPT is now your default provider for chat."),
    ).toBeDefined();
    expect(putBodies).toEqual([
      { provider: "chatgpt", connectionName: "chatgpt-subscription" },
    ]);
    expect(screen.queryByText("Use ChatGPT for chat")).toBeNull();
    expect(connected.length).toBe(0);

    fireEvent.click(screen.getByText("Done"));

    expect(connected).toEqual([STORED_CONNECTION]);
  });

  test("a working default is left alone behind a button", async () => {
    const connected: ProviderConnection[] = [];
    renderSection((c) => connected.push(c));

    signIn();

    const useForChat = await screen.findByText("Use ChatGPT for chat");
    expect(putBodies).toEqual([]);

    fireEvent.click(useForChat);

    expect(
      await screen.findByText("ChatGPT is now your default provider for chat."),
    ).toBeDefined();
    expect(putBodies).toEqual([
      { provider: "chatgpt", connectionName: "chatgpt-subscription" },
    ]);
    expect(connected.length).toBe(0);
  });

  test("an unreadable default is offered rather than overridden", async () => {
    defaultProviderState = {
      provider: "anthropic",
      resolvedConnectionName: "anthropic-personal",
      availability: {
        status: "unknown",
        message: "The credential store is unreachable.",
      },
    };
    renderSection();

    signIn();

    expect(await screen.findByText("Use ChatGPT for chat")).toBeDefined();
    expect(putBodies).toEqual([]);
  });

  test("the switch refreshes the provider, profile and default caches", async () => {
    defaultProviderState = {
      provider: "anthropic",
      resolvedConnectionName: "anthropic-personal",
      availability: { status: "missing_credential" },
    };
    renderSection();

    signIn();

    await screen.findByText("ChatGPT is now your default provider for chat.");
    for (const id of [
      "inferenceProviderconnectionsGet",
      "configLlmDefaultproviderGet",
      "configGet",
      "inferenceProfilesGet",
    ]) {
      expect(invalidatedQueryIds).toContain(id);
    }
  });

  test("a failed switch falls back to the button", async () => {
    defaultProviderState = {
      provider: "anthropic",
      resolvedConnectionName: "anthropic-personal",
      availability: { status: "missing_credential" },
    };
    putShouldFail = true;
    renderSection();

    signIn();

    expect(await screen.findByText("Use ChatGPT for chat")).toBeDefined();
    expect(toastErrors).toEqual([
      "Failed to set the default provider. Please try again.",
    ]);
  });

  test("nothing is asked when ChatGPT already is the default", async () => {
    defaultProviderState = {
      provider: "chatgpt",
      connectionName: "chatgpt-subscription",
      resolvedConnectionName: "chatgpt-subscription",
      availability: { status: "ok" },
    };
    const connected: ProviderConnection[] = [];
    renderSection((c) => connected.push(c));

    signIn();

    await waitFor(() => expect(connected).toEqual([STORED_CONNECTION]));
    expect(screen.queryByText("Use ChatGPT for chat")).toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
    expect(putBodies).toEqual([]);
  });

  test("assistants without the default-provider routes hand over as before", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.7");
    const connected: ProviderConnection[] = [];
    renderSection((c) => connected.push(c));

    signIn();

    await waitFor(() => expect(connected).toEqual([STORED_CONNECTION]));
    expect(screen.queryByText("Use ChatGPT for chat")).toBeNull();
    expect(putBodies).toEqual([]);
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

  // The paste flow is identified by its steps, not its button: standing alone
  // it wears the same "Sign in with ChatGPT" name the device code had.
  test("hands the section to the paste flow on a daemon without the route", async () => {
    startUnsupported = true;
    renderSection();

    fireEvent.click(screen.getByText("Sign in with ChatGPT"));

    await screen.findByText(
      "3. Copy the full URL from that page's address bar and paste it below",
    );
    expect(
      screen.getByText('1. Click "Sign in with ChatGPT" below to open a popup'),
    ).toBeDefined();
    expect(screen.queryByText("Open ChatGPT sign-in")).toBeNull();
    expect(screen.queryByText("Other sign-in options")).toBeNull();
    expect(
      screen.queryByText("Could not start ChatGPT sign-in. Please try again."),
    ).toBeNull();
  });

  // Beside the device code the paste flow narrows to the tab it opens, so the
  // two sign-ins on screen do not both claim to be "Sign in with ChatGPT".
  test("the paste flow stays reachable behind the disclosure", () => {
    renderSection();

    expect(screen.queryByText("Open ChatGPT sign-in")).toBeNull();

    fireEvent.click(screen.getByText("Other sign-in options"));

    expect(screen.getByText("Open ChatGPT sign-in")).toBeDefined();
    expect(
      screen.getByText('1. Click "Open ChatGPT sign-in" below to open a popup'),
    ).toBeDefined();
    expect(screen.getByText("Hide other sign-in options")).toBeDefined();
  });

  // The disclosure's sign-in ends on the same step the device code does, and
  // the device code steps aside once the credential is stored.
  test("a paste sign-in behind the disclosure reaches the step", async () => {
    defaultProviderState = {
      provider: "anthropic",
      resolvedConnectionName: "anthropic-personal",
      availability: { status: "missing_credential" },
    };
    const connected: ProviderConnection[] = [];
    renderSection((c) => connected.push(c));

    fireEvent.click(screen.getByText("Other sign-in options"));
    await completePasteSignIn("Open ChatGPT sign-in");

    expect(
      await screen.findByText("ChatGPT is now your default provider for chat."),
    ).toBeDefined();
    expect(putBodies).toEqual([
      { provider: "chatgpt", connectionName: "chatgpt-subscription" },
    ]);
    expect(screen.queryByText("Sign in with ChatGPT")).toBeNull();
    expect(screen.queryByText("Hide other sign-in options")).toBeNull();
    expect(connected.length).toBe(0);

    fireEvent.click(screen.getByText("Done"));

    expect(connected).toEqual([STORED_CONNECTION]);
  });
});

describe("ChatgptOAuthSection with device-code login off", () => {
  beforeEach(() => {
    resetState();
    setDeviceCodeLoginFlag(false);
  });

  afterEach(() => {
    cleanup();
    useAssistantIdentityStore.getState().clearIdentity();
  });

  test("the paste flow is the whole section", () => {
    renderSection();

    expect(
      screen.getByText(
        "3. Copy the full URL from that page's address bar and paste it below",
      ),
    ).toBeDefined();
    expect(screen.queryByText("Other sign-in options")).toBeNull();
    expect(screen.queryByText("Hide other sign-in options")).toBeNull();
    expect(startCalls).toBe(0);
  });

  // Standing alone the flow is the sign-in, so it carries the name it had
  // before the device code arrived beside it and narrowed it.
  test("wears the plain sign-in name rather than the fallback's", () => {
    renderSection();

    expect(screen.getByText("Sign in with ChatGPT")).toBeDefined();
    expect(
      screen.getByText('1. Click "Sign in with ChatGPT" below to open a popup'),
    ).toBeDefined();
    expect(screen.queryByText("Open ChatGPT sign-in")).toBeNull();
    expect(
      screen.queryByText(
        '1. Click "Open ChatGPT sign-in" below to open a popup',
      ),
    ).toBeNull();
  });

  // A mount that reads the pre-hydration default owns the section for that
  // visit. Adopting the value that lands afterwards would unmount the paste
  // flow along with a PKCE exchange the user may already have started.
  test("a flag value arriving after mount leaves the paste flow standing", () => {
    renderSection();

    act(() => setDeviceCodeLoginFlag(true));

    expect(
      screen.getByText(
        "3. Copy the full URL from that page's address bar and paste it below",
      ),
    ).toBeDefined();
    expect(
      screen.getByText('1. Click "Sign in with ChatGPT" below to open a popup'),
    ).toBeDefined();
    expect(screen.queryByText("Other sign-in options")).toBeNull();
    expect(
      screen.queryByText("Enter this code on the ChatGPT page."),
    ).toBeNull();
    expect(startCalls).toBe(0);
  });

  test("a default that cannot serve a turn is switched without asking", async () => {
    defaultProviderState = {
      provider: "anthropic",
      resolvedConnectionName: "anthropic-personal",
      availability: { status: "missing_credential" },
    };
    const connected: ProviderConnection[] = [];
    renderSection((c) => connected.push(c));

    await completePasteSignIn("Sign in with ChatGPT");

    expect(
      await screen.findByText("ChatGPT is now your default provider for chat."),
    ).toBeDefined();
    expect(putBodies).toEqual([
      { provider: "chatgpt", connectionName: "chatgpt-subscription" },
    ]);
    expect(connected.length).toBe(0);

    fireEvent.click(screen.getByText("Done"));

    expect(connected).toEqual([STORED_CONNECTION]);
  });

  test("a working default is left alone behind a button", async () => {
    const connected: ProviderConnection[] = [];
    renderSection((c) => connected.push(c));

    await completePasteSignIn("Sign in with ChatGPT");

    const useForChat = await screen.findByText("Use ChatGPT for chat");
    expect(putBodies).toEqual([]);

    fireEvent.click(useForChat);

    expect(
      await screen.findByText("ChatGPT is now your default provider for chat."),
    ).toBeDefined();
    expect(putBodies).toEqual([
      { provider: "chatgpt", connectionName: "chatgpt-subscription" },
    ]);
    expect(connected.length).toBe(0);
  });
});
