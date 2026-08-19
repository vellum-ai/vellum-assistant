import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { LocalListDevicesResult } from "@/runtime/local-mode-host";

let gatewayPath: string | undefined = "/assistant/__gateway/20100";
let supportsPairingRoutes = true;
let webRemoteIngressOn = true;
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
      webRemoteIngress: () => webRemoteIngressOn,
    },
  },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

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
const {
  createTimerHarness,
  fetchLog,
  installFetch: installRecordingFetch,
  jsonResponse,
  pendingRequest,
  requestBody,
  resetFetchLog,
  restoreFetch,
} = await import("./pair-device-test-helpers");

const PUBLIC_URL = "https://foo.ts.net";
const PAIR_URL = "https://foo.ts.net/assistant/pair#device_code=DEV-123";

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

beforeEach(() => {
  gatewayPath = "/assistant/__gateway/20100";
  supportsPairingRoutes = true;
  webRemoteIngressOn = true;
  selectedAssistant = { assistantId: "self", cloud: "local" };
  listDevicesResult = { ok: false, error: "unavailable" };
  listDevicesCalls = 0;
  resetFetchLog();
  localStorage.clear();
  // A rendered card polls the pending-request list on mount, so every test
  // needs the route answered; minting stays unexpected unless overridden.
  installFetch(unexpectedMint);
});

afterEach(() => {
  cleanup();
  restoreFetch();
});

describe("PairDeviceCard", () => {
  test("renders nothing when there is no local gateway (remote/platform mode)", () => {
    gatewayPath = undefined;
    const { container } = render(<PairDeviceCard />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pair a device")).toBeNull();
  });

  test("renders the section in local mode", () => {
    render(<PairDeviceCard />);
    expect(screen.getByText("Pair a device")).toBeTruthy();
    expect(screen.getByLabelText("Public URL")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    ).toBeTruthy();
  });

  test("renders nothing against an assistant without the pairing routes", () => {
    supportsPairingRoutes = false;
    const { container } = render(<PairDeviceCard />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pair a device")).toBeNull();
  });

  test("renders nothing when web-remote-ingress is off", () => {
    // The client flag only controls the card's visibility.
    webRemoteIngressOn = false;
    const { container } = render(<PairDeviceCard />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pair a device")).toBeNull();
  });

  test("mints + approves, then shows the QR and pair URL", async () => {
    installFetch(() => jsonResponse(challengeBody()));
    render(<PairDeviceCard />);
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
    render(<PairDeviceCard />);
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
    render(<PairDeviceCard />);
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
    render(<PairDeviceCard />);

    const input = screen.getByLabelText("Public URL") as HTMLInputElement;
    expect(input.value).toBe("https://tunnel.example.ts.net");
    // Helper text explains the prefilled address came from `vellum tunnel`.
    expect(screen.getByText(/comes from/)).toBeTruthy();
    // A recorded tunnel URL suppresses the no-tunnel empty state.
    expect(screen.queryByText("No tunnel detected")).toBeNull();
  });

  test("shows honest no-tunnel guidance when no ingress URL and no stored value", () => {
    render(<PairDeviceCard />);

    expect(screen.getByText("No tunnel detected")).toBeTruthy();
    expect(screen.getByText(/vellum tunnel --provider tailscale/)).toBeTruthy();
    // The manual field stays available beneath the guidance.
    expect(screen.getByLabelText("Public URL")).toBeTruthy();
    expect(
      (screen.getByLabelText("Public URL") as HTMLInputElement).value,
    ).toBe("");
  });

  test("rejects a tunnel-provider website URL (Tailscale admin invite) with a service-website message", () => {
    installFetch(() => jsonResponse(challengeBody()));
    render(<PairDeviceCard />);
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
    render(<PairDeviceCard />);

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
    render(<PairDeviceCard />);

    expect(
      await screen.findByRole("button", { name: "Paired devices (1)" }),
    ).toBeTruthy();
  });

  test("falls back to generic copy when the assistant has no name", () => {
    render(<PairDeviceCard />);

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
    render(<PairDeviceCard />);

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
    render(<PairDeviceCard />);

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
    render(<PairDeviceCard />);

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
        render(<PairDeviceCard />);
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
    render(<PairDeviceCard />);
    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(actionCalls("approve")).toHaveLength(1));
    expect(requestBody(actionCalls("approve")[0])).toEqual({ requestId: "req-1" });
    await waitFor(() => expect(screen.queryByText("QRST-7890")).toBeNull());
    expect(actionCalls("deny")).toHaveLength(0);
  });

  test("approving a pending request refetches the paired-device list", async () => {
    installPendingFetch();
    render(<PairDeviceCard />);
    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());
    const callsBeforeApprove = listDevicesCalls;

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(listDevicesCalls).toBeGreaterThan(callsBeforeApprove),
    );
  });

  test("Deny posts the request id and removes the row", async () => {
    installPendingFetch();
    render(<PairDeviceCard />);
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
    render(<PairDeviceCard />);
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
    render(<PairDeviceCard />);

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
    render(<PairDeviceCard />);

    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());
    expect(
      screen.getByText(/Requested 2 minutes ago from 203\.0\.113\.7/),
    ).toBeTruthy();
  });

  test("stays hidden with the card when there is no local gateway", () => {
    gatewayPath = undefined;
    installPendingFetch();
    const { container } = render(<PairDeviceCard />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pairing requests")).toBeNull();
    // The gate keeps the poll from ever firing.
    expect(fetchLog).toHaveLength(0);
  });

  test("stays hidden with the card when web-remote-ingress is off", () => {
    webRemoteIngressOn = false;
    installPendingFetch();
    const { container } = render(<PairDeviceCard />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pairing requests")).toBeNull();
    expect(fetchLog).toHaveLength(0);
  });
});
