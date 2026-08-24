import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { publish, __resetForTesting as resetEventBus } from "@/lib/event-bus";
import type { LocalListDevicesResult } from "@/runtime/local-mode-host";

import {
  createQueryClientWrapper,
  createTimerHarness,
  fetchLog,
  installFetch as installRecordingFetch,
  installIngressProbe,
  jsonResponse,
  pendingRequest,
  requestBody,
  resetFetchLog,
  restoreFetch,
  VERSION_BELOW_INGRESS_STATUS,
} from "./pair-device-test-helpers";

let gatewayPath: string | undefined = "/assistant/__gateway/20100";
let supportsPairingRoutes = true;
let pairedDevicesUIOn = true;
let selectedAssistant: {
  assistantId: string;
  cloud: string;
  name?: string;
  ingressUrl?: string;
} = { assistantId: "self", cloud: "local" };

// Spread the real module so transitive consumers (e.g. the pending-request
// chain) keep every export; only the reads the tests drive are overridden.
const actualLocalMode = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...actualLocalMode,
  getLocalGatewayUrl: () => gatewayPath,
  getSelectedAssistant: () => selectedAssistant,
}));

mock.module("@/lib/backwards-compat/remote-web-pairing-gate", () => ({
  useSupportsRemoteWebPairing: () => supportsPairingRoutes,
}));

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: {
      pairedDevicesUI: () => pairedDevicesUIOn,
    },
  },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

const {
  probe: probeMock,
  respondWith: probeAnswers,
  failWith: probeFails,
  stall: probeStalls,
  reset: resetProbe,
} = await installIngressProbe({ state: "unconfigured" });

let listDevicesResult: LocalListDevicesResult = {
  ok: false,
  error: "unavailable",
};
let listDevicesCalls = 0;

mock.module(
  "@/runtime/local-mode-host",
  (): Partial<typeof import("@/runtime/local-mode-host")> => ({
    listPairedDevicesHost: async () => {
      listDevicesCalls += 1;
      return listDevicesResult;
    },
    revokePairedDeviceHost: async () => ({ ok: true }),
  }),
);

const { PairDeviceCard } = await import("./pair-device-card");
const { MIN_VERSION: INGRESS_STATUS_MIN_VERSION } = await import(
  "@/lib/backwards-compat/ingress-status-gate"
);
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);
const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);
const PUBLIC_URL = "https://foo.ts.net";
const PAIR_URL = "https://foo.ts.net/assistant/pair#device_code=DEV-123";
const ASSISTANT_ID = "self";
const TUNNEL_URL = "https://tunnel.example.ts.net";
const RECORDED_INGRESS_URL = "https://recorded.example.ts.net";
/** Where `usePairDevice` remembers the last URL that minted a code. */
const STORED_URL_KEY = "vellum:pair-device:public-base-url";
const STORED_URL = "https://stored.example.ts.net";

/** Move the active assistant onto a version whose daemon serves the probe. */
function enableTunnelStatus() {
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test", INGRESS_STATUS_MIN_VERSION, ASSISTANT_ID);
}

function healthyStatus(publicBaseUrl = TUNNEL_URL) {
  return {
    state: "healthy" as const,
    publicBaseUrl,
    checkedAt: new Date().toISOString(),
  };
}

/** Render inside a fresh query client, which the tunnel-status probe needs. */
function renderCard() {
  const { wrapper: QueryWrapper } = createQueryClientWrapper();
  return render(
    <QueryWrapper>
      <PairDeviceCard />
    </QueryWrapper>,
  );
}

function urlField(): HTMLInputElement {
  return screen.getByLabelText("Public URL") as HTMLInputElement;
}

function futureIso(): string {
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

function challengeBody() {
  return {
    deviceCode: "DEV-123",
    userCode: "WXYZ-1234",
    verificationUri: "https://foo.ts.net/assistant/pair",
    expiresAt: futureIso(),
    expiresInSeconds: 600,
    intervalSeconds: 5,
  };
}

function pendingRequestBody(
  overrides: Parameters<typeof pendingRequest>[0] = {},
) {
  return pendingRequest({
    userCode: "QRST-7890",
    publicBaseUrl: PUBLIC_URL,
    requestedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    expiresAt: futureIso(),
    requesterUserAgent: "Mozilla/5.0 (iPhone; like Mac OS X)",
    // Default rows carry a public requester IP, so they read as edge mints.
    viaEdgeProxy: true,
    ...overrides,
  });
}

interface FetchHandlers {
  onVerification?: () => Response;
  onPendingRequests?: () => Response | Promise<Response>;
  onRequestAction?: () => Response | Promise<Response>;
}

function unexpectedMint(): Response {
  throw new Error("unexpected challenge mint");
}

/** Install a fetch mock that records requests and answers per route. */
function installFetch(
  onChallenge: () => Response,
  {
    onVerification = () =>
      jsonResponse({
        status: "approved",
        verificationUri: "https://foo.ts.net/assistant/pair",
        expiresAt: futureIso(),
      }),
    onPendingRequests = () => jsonResponse({ requests: [] }),
    onRequestAction = () => jsonResponse({ status: "done" }),
  }: FetchHandlers = {},
) {
  return installRecordingFetch((url) => {
    if (url.endsWith("/v1/remote-web/pairing-challenge")) {
      return onChallenge();
    }
    if (url.endsWith("/v1/remote-web/pairing-verification")) {
      return onVerification();
    }
    if (url.endsWith("/v1/remote-web/pairing-requests")) {
      return onPendingRequests();
    }
    if (
      url.endsWith("/v1/remote-web/pairing-requests/approve") ||
      url.endsWith("/v1/remote-web/pairing-requests/deny")
    ) {
      return onRequestAction();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function actionCalls(action: "approve" | "deny") {
  return fetchLog.filter((request) =>
    request.url.endsWith(`/v1/remote-web/pairing-requests/${action}`),
  );
}

/** The mint-flow calls (challenge + verification), without the section's list polls. */
function mintCalls() {
  return fetchLog.filter(
    (request) => !request.url.endsWith("/v1/remote-web/pairing-requests"),
  );
}

function typeUrl(value: string) {
  fireEvent.change(screen.getByLabelText("Public URL"), {
    target: { value },
  });
}

/** The disclosure the URL field hides behind once an address is known. */
const URL_DISCLOSURE_LABEL = "Use a different address";

function urlDisclosure(): HTMLElement | null {
  return screen.queryByRole("button", { name: URL_DISCLOSURE_LABEL });
}

function openUrlField() {
  fireEvent.click(screen.getByRole("button", { name: URL_DISCLOSURE_LABEL }));
}

/** The re-check the status row and the first-run notice both offer. */
const RECHECK_LABEL = "Check the tunnel again";

function recheckButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: RECHECK_LABEL });
}

beforeEach(() => {
  gatewayPath = "/assistant/__gateway/20100";
  supportsPairingRoutes = true;
  pairedDevicesUIOn = true;
  selectedAssistant = { assistantId: "self", cloud: "local" };
  listDevicesResult = { ok: false, error: "unavailable" };
  listDevicesCalls = 0;
  resetFetchLog();
  localStorage.clear();
  resetProbe();
  useResolvedAssistantsStore.getState().setActiveAssistantId(ASSISTANT_ID);
  // Tests that exercise the status row opt into a version that serves it.
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test", VERSION_BELOW_INGRESS_STATUS, ASSISTANT_ID);
  // A rendered card polls the pending-request list on mount, so every test
  // needs the route answered; minting stays unexpected unless overridden.
  installFetch(unexpectedMint);
});

afterEach(() => {
  cleanup();
  restoreFetch();
  resetEventBus();
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("PairDeviceCard", () => {
  test("renders nothing when there is no local gateway (remote/platform mode)", () => {
    gatewayPath = undefined;
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pair a device")).toBeNull();
  });

  test("renders the section in local mode", () => {
    renderCard();
    expect(screen.getByText("Pair a device")).toBeTruthy();
    expect(screen.getByLabelText("Public URL")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    ).toBeTruthy();
  });

  test("renders nothing against an assistant without the pairing routes", () => {
    supportsPairingRoutes = false;
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pair a device")).toBeNull();
  });

  test("mints + approves, then shows the QR and pair URL", async () => {
    installFetch(() => jsonResponse(challengeBody()));
    renderCard();
    typeUrl(PUBLIC_URL);
    fireEvent.click(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    );

    await waitFor(() =>
      expect(screen.getByTitle("Device pairing QR code")).toBeTruthy(),
    );
    expect(screen.getByTestId("pair-device-url").textContent).toBe(PAIR_URL);

    expect(mintCalls()).toHaveLength(2);
    expect(mintCalls()[0]?.url).toContain(
      "/assistant/__gateway/20100/v1/remote-web/pairing-challenge",
    );
    expect(requestBody(mintCalls()[0])).toEqual({ publicBaseUrl: PUBLIC_URL });
    expect(mintCalls()[1]?.url).toContain(
      "/assistant/__gateway/20100/v1/remote-web/pairing-verification",
    );
    expect(requestBody(mintCalls()[1])).toEqual({ userCode: "WXYZ-1234" });
  });

  test("surfaces the server's rejection message with a connectivity hint", async () => {
    installFetch(() =>
      jsonResponse(
        { error: { code: "LOOPBACK_REQUIRED", message: "loopback required" } },
        403,
      ),
    );
    renderCard();
    typeUrl(PUBLIC_URL);
    fireEvent.click(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    );

    await waitFor(() =>
      expect(screen.getByText("loopback required")).toBeTruthy(),
    );
    expect(screen.getByText(/vellum tunnel/)).toBeTruthy();
  });

  test("blocks a loopback URL client-side without a network call", () => {
    installFetch(() => jsonResponse(challengeBody()));
    renderCard();
    typeUrl("http://localhost:3000");
    fireEvent.click(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    );

    expect(
      screen.getByText(
        "This is a loopback address other devices can't reach. Enter the assistant's public https URL.",
      ),
    ).toBeTruthy();
    expect(mintCalls()).toHaveLength(0);
  });

  test("prefills the URL field from the assistant's recorded tunnel URL", () => {
    selectedAssistant = {
      assistantId: "self",
      cloud: "local",
      ingressUrl: "https://tunnel.example.ts.net",
    };
    renderCard();

    const input = screen.getByLabelText("Public URL") as HTMLInputElement;
    expect(input.value).toBe("https://tunnel.example.ts.net");
    // Helper text explains the prefilled address came from `vellum tunnel`.
    expect(screen.getByText(/comes from/)).toBeTruthy();
    // A recorded tunnel URL suppresses the no-tunnel empty state.
    expect(screen.queryByText("Open a tunnel first")).toBeNull();
  });

  test("shows honest no-tunnel guidance when no ingress URL and no stored value", () => {
    renderCard();

    expect(screen.getByText("Open a tunnel first")).toBeTruthy();
    expect(screen.getByText("vellum tunnel --provider tailscale")).toBeTruthy();
    expect(screen.getByText(/Paste it into Public URL below/)).toBeTruthy();
    expect(screen.getByText("vellum tunnel --help")).toBeTruthy();
    // The manual field stays available beneath the guidance.
    expect(screen.getByLabelText("Public URL")).toBeTruthy();
    expect(
      (screen.getByLabelText("Public URL") as HTMLInputElement).value,
    ).toBe("");
  });

  test("rejects a tunnel-provider website URL (Tailscale admin invite) with a service-website message", () => {
    installFetch(() => jsonResponse(challengeBody()));
    renderCard();
    typeUrl("https://login.tailscale.com/admin/invite/abc123");
    fireEvent.click(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    );

    expect(
      screen.getByText(
        "This is Tailscale's website, not your assistant's address. Run `vellum tunnel` on the host to get one.",
      ),
    ).toBeTruthy();
    // The bad URL is refused client-side — no challenge is ever minted.
    expect(mintCalls()).toHaveLength(0);
  });

  test("names the assistant it pairs in the subtitle", () => {
    selectedAssistant = {
      assistantId: "self",
      cloud: "local",
      name: "My Assistant",
    };
    renderCard();

    expect(
      screen.getByText(
        "Scan with another device's camera, or open the link on it, to use My Assistant there.",
      ),
    ).toBeTruthy();
  });

  test("shows the paired-devices section when the host reports a device", async () => {
    listDevicesResult = {
      ok: true,
      devices: [
        {
          hashedDeviceId: "aaaabbbbccccdddd0000111122223333",
          platform: "ios",
          issuedAt: null,
          expiresAt: null,
          lastUsedAt: null,
        },
      ],
    };
    renderCard();

    expect(
      await screen.findByRole("button", { name: "Paired devices (1)" }),
    ).toBeTruthy();
  });

  test("hides the paired-devices section when paired-devices-ui is off", async () => {
    // The rest of the card stays; only the list + revoke section is gated.
    pairedDevicesUIOn = false;
    listDevicesResult = {
      ok: true,
      devices: [
        {
          hashedDeviceId: "aaaabbbbccccdddd0000111122223333",
          platform: "ios",
          issuedAt: null,
          expiresAt: null,
          lastUsedAt: null,
        },
      ],
    };
    renderCard();

    expect(screen.getByText("Pair a device")).toBeTruthy();
    // The mount-time pending-request poll settles; the device list is never
    // fetched, so the host `vellum devices` spawn never happens.
    await waitFor(() =>
      expect(
        fetchLog.some((r) => r.url.endsWith("/v1/remote-web/pairing-requests")),
      ).toBe(true),
    );
    expect(screen.queryByRole("button", { name: /Paired devices/ })).toBeNull();
    expect(listDevicesCalls).toBe(0);
  });

  test("falls back to generic copy when the assistant has no name", () => {
    renderCard();

    expect(
      screen.getByText(
        "Scan with another device's camera, or open the link on it, to use this assistant there.",
      ),
    ).toBeTruthy();
  });
});

describe("PairDeviceCard: pending pairing requests", () => {
  function installPendingFetch(handlers: FetchHandlers = {}) {
    return installFetch(unexpectedMint, {
      onPendingRequests: () =>
        jsonResponse({ requests: [pendingRequestBody()] }),
      ...handlers,
    });
  }

  test("hides the approval section while no request is pending", async () => {
    renderCard();

    // The list was polled and came back empty.
    await waitFor(() =>
      expect(
        fetchLog.some((r) => r.url.endsWith("/v1/remote-web/pairing-requests")),
      ).toBe(true),
    );
    expect(screen.queryByText("Pairing requests")).toBeNull();
  });

  test("a failing list poll surfaces the error notice even with no rows", async () => {
    installFetch(unexpectedMint, {
      onPendingRequests: () =>
        jsonResponse({ error: { message: "gateway unreachable" } }, 500),
    });
    renderCard();

    await waitFor(() =>
      expect(screen.getByText("gateway unreachable")).toBeTruthy(),
    );
    // The section shows with the error so an outage isn't mistaken for an
    // empty queue, but no request rows or actions are offered.
    expect(screen.getByText("Pairing requests")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  test("renders a pending request's user code and requester metadata", async () => {
    installPendingFetch();
    renderCard();

    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());
    expect(screen.getByText("Pairing requests")).toBeTruthy();
    // The anti-phishing binding: approval is tied to matching the code shown
    // on the requesting device.
    expect(
      screen.getByText(/matches the one shown on the requesting device/),
    ).toBeTruthy();
    // The relative timestamp is locale-aware (en active in tests).
    expect(
      screen.getByText(/Requested 2 minutes ago from 203\.0\.113\.7/),
    ).toBeTruthy();
    expect(
      screen.getByText("Mozilla/5.0 (iPhone; like Mac OS X)"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  test("the relative request age advances while the request stays pending", async () => {
    installPendingFetch();
    // Timer harness instead of fake timers (bun has none): `waitFor` needs
    // real timers, so this test flushes with `act` and restores in `finally`.
    const timerHarness = createTimerHarness();
    const realDateNow = Date.now;
    timerHarness.install();
    try {
      await act(async () => {
        renderCard();
      });
      expect(screen.getByText(/Requested 2 minutes ago/)).toBeTruthy();

      // Advance the clock 3 minutes and fire the age-refresh tick.
      const now = realDateNow();
      Date.now = () => now + 3 * 60_000;
      const ageTick = timerHarness.timers.find(
        (timer) => timer.delay === 30_000,
      );
      expect(ageTick).toBeTruthy();
      act(() => ageTick?.handler());

      expect(screen.getByText(/Requested 5 minutes ago/)).toBeTruthy();
    } finally {
      timerHarness.restore();
      Date.now = realDateNow;
    }
  });

  test("Approve posts the request id and removes the row", async () => {
    installPendingFetch();
    renderCard();
    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(actionCalls("approve")).toHaveLength(1));
    expect(requestBody(actionCalls("approve")[0])).toEqual({ requestId: "req-1" });
    await waitFor(() => expect(screen.queryByText("QRST-7890")).toBeNull());
    expect(actionCalls("deny")).toHaveLength(0);
  });

  test("approving a pending request refetches the paired-device list", async () => {
    installPendingFetch();
    renderCard();
    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());
    const callsBeforeApprove = listDevicesCalls;

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(listDevicesCalls).toBeGreaterThan(callsBeforeApprove),
    );
  });

  test("Deny posts the request id and removes the row", async () => {
    installPendingFetch();
    renderCard();
    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(actionCalls("deny")).toHaveLength(1));
    expect(requestBody(actionCalls("deny")[0])).toEqual({ requestId: "req-1" });
    await waitFor(() => expect(screen.queryByText("QRST-7890")).toBeNull());
    expect(actionCalls("approve")).toHaveLength(0);
  });

  test("action buttons disable and the acted button shows busy while an action is in flight", async () => {
    // An approve that never resolves keeps the action in flight.
    installPendingFetch({
      onRequestAction: () => new Promise<Response>(() => {}),
    });
    renderCard();
    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      (screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Only the acted button carries the busy state.
    const approveButton = screen.getByRole("button", { name: "Approve" });
    expect(approveButton.getAttribute("aria-busy")).toBe("true");
    expect(approveButton.querySelector(".animate-spin")).toBeTruthy();
    const denyButton = screen.getByRole("button", { name: "Deny" });
    expect(denyButton.getAttribute("aria-busy")).toBeNull();
    expect(denyButton.querySelector(".animate-spin")).toBeNull();
  });

  test("a host-originated request says 'from this computer' instead of a loopback IP", async () => {
    installPendingFetch({
      onPendingRequests: () =>
        jsonResponse({
          requests: [
            pendingRequestBody({ requesterIp: "127.0.0.1", viaEdgeProxy: false }),
          ],
        }),
    });
    renderCard();

    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());
    expect(
      screen.getByText(/Requested 2 minutes ago from this computer/),
    ).toBeTruthy();
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
  });

  test("a tunnel-edge request keeps showing the requester IP", async () => {
    installPendingFetch({
      onPendingRequests: () =>
        jsonResponse({ requests: [pendingRequestBody({ viaEdgeProxy: true })] }),
    });
    renderCard();

    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());
    expect(
      screen.getByText(/Requested 2 minutes ago from 203\.0\.113\.7/),
    ).toBeTruthy();
  });

  test("stays hidden with the card when there is no local gateway", () => {
    gatewayPath = undefined;
    installPendingFetch();
    const { container } = renderCard();

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pairing requests")).toBeNull();
    // The gate keeps the poll from ever firing.
    expect(fetchLog).toHaveLength(0);
  });
});

describe("PairDeviceCard: tunnel status", () => {
  beforeEach(() => {
    enableTunnelStatus();
  });

  test("shows the status row for a healthy tunnel, without the first-run notice", async () => {
    probeAnswers(healthyStatus());
    renderCard();

    expect(
      await screen.findByText("The tunnel is running and reachable."),
    ).toBeTruthy();
    expect(screen.getByText(TUNNEL_URL)).toBeTruthy();
    expect(screen.queryByText("Open a tunnel first")).toBeNull();
  });

  test("shows the first-run notice only once the daemon reports no tunnel", async () => {
    probeAnswers({ state: "unconfigured" });
    renderCard();

    // The in-flight probe is not an empty state, so the row speaks first.
    expect(
      screen.getByText("Checking whether the tunnel is reachable…"),
    ).toBeTruthy();
    expect(screen.queryByText("Open a tunnel first")).toBeNull();

    expect(await screen.findByText("Open a tunnel first")).toBeTruthy();
    expect(screen.getByText("vellum tunnel --provider tailscale")).toBeTruthy();
  });

  // The user leaves this state to run `vellum tunnel` in a terminal beside the
  // window, which is never a foreground edge, so `app.resume` alone would
  // strand the card on "Open a tunnel first" until a full reload.
  test("re-checks from the first-run notice, which the row cannot offer", async () => {
    probeAnswers({ state: "unconfigured" });
    renderCard();
    await screen.findByText("Open a tunnel first");
    expect(probeMock).toHaveBeenCalledTimes(1);

    probeAnswers(healthyStatus());
    fireEvent.click(recheckButton()!);

    await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText("The tunnel is running and reachable."),
    ).toBeTruthy();
    expect(screen.queryByText("Open a tunnel first")).toBeNull();
  });

  test("re-checks the tunnel when the app resumes", async () => {
    probeAnswers(healthyStatus());
    renderCard();
    await screen.findByText("The tunnel is running and reachable.");
    expect(probeMock).toHaveBeenCalledTimes(1);

    act(() => publish("app.resume", { signal: "visibility" }));

    await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(2));
  });

  test("prefills the URL field from the daemon's address, not the recorded one", async () => {
    selectedAssistant = {
      assistantId: ASSISTANT_ID,
      cloud: "local",
      ingressUrl: RECORDED_INGRESS_URL,
    };
    probeAnswers(healthyStatus());
    renderCard();

    await screen.findByText("The tunnel is running and reachable.");
    openUrlField();
    expect(urlField().value).toBe(TUNNEL_URL);
    // The helper text still credits `vellum tunnel` for the address.
    expect(screen.getByText(/comes from/)).toBeTruthy();
  });

  test("keeps the first-run notice for the daemon's own unconfigured verdict", async () => {
    // The daemon is the authority once it answers: a recorded URL it no longer
    // reports is stale, so it does not suppress the notice or fill the field.
    selectedAssistant = {
      assistantId: ASSISTANT_ID,
      cloud: "local",
      ingressUrl: RECORDED_INGRESS_URL,
    };
    probeAnswers({ state: "unconfigured" });
    renderCard();

    expect(await screen.findByText("Open a tunnel first")).toBeTruthy();
    expect(urlField().value).toBe("");
  });

  test("keeps a typed URL, and the field open, when the probe answers again", async () => {
    probeAnswers(healthyStatus());
    renderCard();
    await screen.findByText("The tunnel is running and reachable.");
    openUrlField();
    typeUrl(PUBLIC_URL);

    act(() => publish("app.resume", { signal: "visibility" }));
    await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(2));
    expect(urlField().value).toBe(PUBLIC_URL);
  });

  test("offers a primary Generate button when the tunnel is healthy", async () => {
    probeAnswers(healthyStatus());
    renderCard();

    await screen.findByText("The tunnel is running and reachable.");
    const button = screen.getByRole("button", {
      name: "Generate pairing QR",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.className).toContain("bg-[var(--primary-base)]");
  });

  test("an unreachable tunnel demotes Generate without disabling it", async () => {
    probeAnswers({
      state: "unreachable",
      publicBaseUrl: TUNNEL_URL,
      checkedAt: new Date().toISOString(),
    });
    renderCard();

    const button = (await screen.findByRole("button", {
      name: "Generate anyway",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.className).toContain("bg-transparent");
    // The status row carries the warning, so the card adds no second notice.
    expect(
      screen.getByText("This address is not answering right now."),
    ).toBeTruthy();
    expect(screen.queryByText("Open a tunnel first")).toBeNull();
  });

  test("a tunnel that cannot pair demotes Generate without disabling it", async () => {
    probeAnswers({
      state: "unpairable",
      publicBaseUrl: TUNNEL_URL,
      checkedAt: new Date().toISOString(),
      detail: "HTTP 404",
    });
    renderCard();

    const button = (await screen.findByRole("button", {
      name: "Generate anyway",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.className).toContain("bg-transparent");
    expect(
      screen.getByText(
        "This address answers, but it is not serving the pairing app. Start a tunnel with the web app enabled so pairing links open.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Open a tunnel first")).toBeNull();
  });

  test("a foreign tunnel gets the same Generate anyway treatment", async () => {
    probeAnswers({
      state: "foreign",
      publicBaseUrl: TUNNEL_URL,
      checkedAt: new Date().toISOString(),
    });
    renderCard();

    const button = (await screen.findByRole("button", {
      name: "Generate anyway",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  test("hides the URL field behind a disclosure once an address is known", async () => {
    probeAnswers(healthyStatus());
    renderCard();

    await screen.findByText("The tunnel is running and reachable.");
    expect(screen.queryByLabelText("Public URL")).toBeNull();

    openUrlField();
    expect(urlField().value).toBe(TUNNEL_URL);
  });

  test("keeps a stored URL on screen while the probe is still checking", async () => {
    // The stale-address hazard: without a verdict yet, the field is prefilled
    // from the last URL that worked, and Generate would mint against it.
    localStorage.setItem(STORED_URL_KEY, STORED_URL);
    probeStalls();
    renderCard();

    expect(
      await screen.findByText("Checking whether the tunnel is reachable…"),
    ).toBeTruthy();
    expect(urlDisclosure()).toBeNull();
    expect(urlField().value).toBe(STORED_URL);
    expect(
      (
        screen.getByRole("button", {
          name: "Generate pairing QR",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test("collapses the field only once the verdict carries the daemon's address", async () => {
    localStorage.setItem(STORED_URL_KEY, STORED_URL);
    probeAnswers(healthyStatus());
    renderCard();

    // First render is the in-flight probe: the stored address still leads.
    expect(urlDisclosure()).toBeNull();
    expect(urlField().value).toBe(STORED_URL);

    await screen.findByText("The tunnel is running and reachable.");
    expect(screen.queryByLabelText("Public URL")).toBeNull();
    openUrlField();
    expect(urlField().value).toBe(TUNNEL_URL);
  });

  test("a verdict arriving mid-typing cannot collapse the field", async () => {
    probeAnswers(healthyStatus());
    renderCard();

    // Typed into the pre-verdict layout, before the disclosure exists.
    typeUrl(PUBLIC_URL);
    await screen.findByText("The tunnel is running and reachable.");

    expect(urlField().value).toBe(PUBLIC_URL);
  });

  test("keeps the URL field in the open when the daemon reports no tunnel", async () => {
    probeAnswers({ state: "unconfigured" });
    renderCard();

    expect(await screen.findByText("Open a tunnel first")).toBeTruthy();
    expect(urlField().value).toBe("");
    expect(urlDisclosure()).toBeNull();
  });

  test("leaves a stopped tunnel's Generate disabled behind an empty field", async () => {
    probeAnswers({
      state: "stopped",
      lastTunnel: { provider: "tailscale", publicBaseUrl: TUNNEL_URL },
    });
    renderCard();

    await screen.findByText(
      "The tunnel is stopped, so other devices cannot reach this assistant.",
    );
    // The recorded address serves nothing, so the row prints it as part of the
    // restart hint and the field stays empty rather than advertising it.
    expect(screen.getByText(TUNNEL_URL)).toBeTruthy();
    expect(urlField().value).toBe("");
    expect(urlDisclosure()).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Generate pairing QR",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  // Reachable after ingress is switched off with no tunnel left on record.
  // The daemon answered, so its verdict stands: falling back here would
  // re-advertise the recorded ingress URL the probe exists to replace.
  test("trusts a stopped verdict the daemon remembers no tunnel for", async () => {
    selectedAssistant = {
      assistantId: ASSISTANT_ID,
      cloud: "local",
      ingressUrl: RECORDED_INGRESS_URL,
    };
    probeAnswers({ state: "stopped" });
    renderCard();

    await screen.findByText(
      "The tunnel is stopped, so other devices cannot reach this assistant.",
    );
    expect(urlField().value).toBe("");
    expect(screen.queryByText("Open a tunnel first")).toBeNull();
    // No provider on record, so nothing claims to know the restart command.
    expect(screen.queryByText(/vellum tunnel --provider/)).toBeNull();
  });

  test("keeps the URL field leading when the verdict carries no address", async () => {
    // `publicBaseUrl` is optional on every state of the flat wire response, so
    // an empty one must not read as an address the card can lead with.
    probeAnswers({ state: "healthy", checkedAt: new Date().toISOString() });
    renderCard();

    expect(
      await screen.findByText("The tunnel is running and reachable."),
    ).toBeTruthy();
    expect(urlDisclosure()).toBeNull();
    expect(urlField().value).toBe("");
  });

  test("tells an unreachable tunnel how to start again, naming the assistant", async () => {
    selectedAssistant = {
      assistantId: ASSISTANT_ID,
      cloud: "local",
      name: "My Assistant",
    };
    probeAnswers({
      state: "unreachable",
      publicBaseUrl: TUNNEL_URL,
      checkedAt: new Date().toISOString(),
      detail: "connection refused",
      lastTunnel: { provider: "tailscale", publicBaseUrl: TUNNEL_URL },
    });
    renderCard();

    expect(
      await screen.findByText("This address is not answering right now."),
    ).toBeTruthy();
    expect(screen.getByText("connection refused")).toBeTruthy();
    expect(
      screen.getByText("vellum tunnel 'My Assistant' --provider tailscale"),
    ).toBeTruthy();
  });

  test("names the assistant in the first-run tunnel command", async () => {
    selectedAssistant = {
      assistantId: ASSISTANT_ID,
      cloud: "local",
      name: "My Assistant",
    };
    probeAnswers({ state: "unconfigured" });
    renderCard();

    expect(await screen.findByText("Open a tunnel first")).toBeTruthy();
    expect(
      screen.getByText("vellum tunnel 'My Assistant' --provider tailscale"),
    ).toBeTruthy();
  });

  test("the check age advances while the card sits open", async () => {
    probeAnswers({
      state: "healthy",
      publicBaseUrl: TUNNEL_URL,
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // Timer harness instead of fake timers (bun has none): the card's age tick
    // is fired by hand, and the harness is restored in `finally`.
    const timerHarness = createTimerHarness();
    const realDateNow = Date.now;
    timerHarness.install();
    try {
      renderCard();
      // `waitFor` needs the real `setInterval` the harness replaced, so the
      // probe's verdict is waited out by hand instead.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(screen.getByText("Checked 1 minute ago")).toBeTruthy();

      // Advance the clock 4 minutes and fire the age-refresh tick.
      const now = realDateNow();
      Date.now = () => now + 4 * 60_000;
      const ageTick = timerHarness.timers.find(
        (timer) => timer.delay === 30_000,
      );
      expect(ageTick).toBeTruthy();
      act(() => ageTick?.handler());

      expect(screen.getByText("Checked 5 minutes ago")).toBeTruthy();
    } finally {
      timerHarness.restore();
      Date.now = realDateNow;
    }
  });

  test("mints against the address typed into the disclosed field", async () => {
    installFetch(() => jsonResponse(challengeBody()));
    probeAnswers(healthyStatus());
    renderCard();
    await screen.findByText("The tunnel is running and reachable.");

    openUrlField();
    typeUrl(PUBLIC_URL);
    fireEvent.click(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    );

    await waitFor(() =>
      expect(screen.getByTitle("Device pairing QR code")).toBeTruthy(),
    );
    expect(requestBody(mintCalls()[0])).toEqual({ publicBaseUrl: PUBLIC_URL });
  });
});

// A probe that never came back tells the card nothing, so it degrades to the
// pre-probe behavior rather than to a blank card the gate-off path would never
// have produced.
describe("PairDeviceCard: when the tunnel probe gives up", () => {
  beforeEach(() => {
    enableTunnelStatus();
    probeFails(new Error("connection refused"));
  });

  test("falls back to the recorded ingress URL, notice and all", async () => {
    selectedAssistant = {
      assistantId: ASSISTANT_ID,
      cloud: "local",
      ingressUrl: RECORDED_INGRESS_URL,
    };
    renderCard();

    await waitFor(() => expect(urlField().value).toBe(RECORDED_INGRESS_URL));
    expect(
      (
        screen.getByRole("button", {
          name: "Generate pairing QR",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByText("Open a tunnel first")).toBeNull();
    // Nothing to report and nothing to re-check from: the row stays silent.
    expect(recheckButton()).toBeNull();
  });

  test("falls back to the field-derived empty state with nothing recorded", async () => {
    renderCard();

    expect(await screen.findByText("Open a tunnel first")).toBeTruthy();
    // Inferred from the field rather than reported, so there is no verdict to
    // re-check and the notice offers none.
    expect(recheckButton()).toBeNull();
    expect(urlField().value).toBe("");
    expect(
      (
        screen.getByRole("button", {
          name: "Generate pairing QR",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("PairDeviceCard: without the ingress-status route", () => {
  test("never probes and keeps the recorded ingress URL as the prefill", async () => {
    selectedAssistant = {
      assistantId: ASSISTANT_ID,
      cloud: "local",
      ingressUrl: RECORDED_INGRESS_URL,
    };
    probeAnswers(healthyStatus());
    renderCard();

    expect(urlField().value).toBe(RECORDED_INGRESS_URL);
    expect(recheckButton()).toBeNull();
    // A recorded URL is the pre-probe evidence of a tunnel, so no first-run
    // notice even though the probe never reported one.
    expect(screen.queryByText("Open a tunnel first")).toBeNull();

    act(() => publish("app.resume", { signal: "visibility" }));
    await waitFor(() =>
      expect(
        fetchLog.some((r) => r.url.endsWith("/v1/remote-web/pairing-requests")),
      ).toBe(true),
    );
    expect(probeMock).not.toHaveBeenCalled();
  });

  test("keeps the field-derived first-run notice with nothing recorded", () => {
    renderCard();

    expect(screen.getByText("Open a tunnel first")).toBeTruthy();
    // A re-check below the version floor would probe a route that is not
    // there, so the notice offers none.
    expect(recheckButton()).toBeNull();
    expect(probeMock).not.toHaveBeenCalled();
  });

  test("leaves the URL field in the open under a primary Generate button", () => {
    selectedAssistant = {
      assistantId: ASSISTANT_ID,
      cloud: "local",
      ingressUrl: RECORDED_INGRESS_URL,
    };
    renderCard();

    // No verdict to steer on: the card behaves as it does without the probe.
    expect(urlField().value).toBe(RECORDED_INGRESS_URL);
    expect(urlDisclosure()).toBeNull();
    const button = screen.getByRole("button", {
      name: "Generate pairing QR",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.className).toContain("bg-[var(--primary-base)]");
  });
});
