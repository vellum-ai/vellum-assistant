import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

let gatewayPath: string | undefined = "/assistant/__gateway/20100";
let supportsPairingRoutes = true;
let webRemoteIngressOn = true;
let selectedAssistant: {
  assistantId: string;
  cloud: string;
  name?: string;
  ingressUrl?: string;
} = { assistantId: "self", cloud: "local" };

mock.module("@/lib/local-mode", () => ({
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

const { PairDeviceCard } = await import("./pair-device-card");

const PUBLIC_URL = "https://foo.ts.net";
const PAIR_URL = "https://foo.ts.net/assistant/pair#device_code=DEV-123";

const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; body: unknown }> = [];

function futureIso(): string {
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

function pendingRequestBody() {
  return {
    requestId: "req-1",
    userCode: "QRST-7890",
    publicBaseUrl: PUBLIC_URL,
    requestedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    expiresAt: futureIso(),
    requesterIp: "203.0.113.7",
    requesterUserAgent: "Mozilla/5.0 (iPhone; like Mac OS X)",
  };
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
  const fetchMock = mock(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
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
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function actionCalls(action: "approve" | "deny") {
  return requests.filter((request) =>
    request.url.endsWith(`/v1/remote-web/pairing-requests/${action}`),
  );
}

/** The mint-flow calls (challenge + verification), without the section's list polls. */
function mintCalls() {
  return requests.filter(
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
  requests = [];
  localStorage.clear();
  // A rendered card polls the pending-request list on mount, so every test
  // needs the route answered; minting stays unexpected unless overridden.
  installFetch(unexpectedMint);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
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
    expect(mintCalls()[0]?.body).toEqual({ publicBaseUrl: PUBLIC_URL });
    expect(mintCalls()[1]?.url).toContain(
      "/assistant/__gateway/20100/v1/remote-web/pairing-verification",
    );
    expect(mintCalls()[1]?.body).toEqual({ userCode: "WXYZ-1234" });
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
        "Scan with another device's camera — or open the link on it — to use My Assistant there.",
      ),
    ).toBeTruthy();
  });

  test("falls back to generic copy when the assistant has no name", () => {
    render(<PairDeviceCard />);

    expect(
      screen.getByText(
        "Scan with another device's camera — or open the link on it — to use this assistant there.",
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
        requests.some((r) => r.url.endsWith("/v1/remote-web/pairing-requests")),
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

  test("Approve posts the request id and removes the row", async () => {
    installPendingFetch();
    render(<PairDeviceCard />);
    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(actionCalls("approve")).toHaveLength(1));
    expect(actionCalls("approve")[0]?.body).toEqual({ requestId: "req-1" });
    await waitFor(() => expect(screen.queryByText("QRST-7890")).toBeNull());
    expect(actionCalls("deny")).toHaveLength(0);
  });

  test("Deny posts the request id and removes the row", async () => {
    installPendingFetch();
    render(<PairDeviceCard />);
    await waitFor(() => expect(screen.getByText("QRST-7890")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(actionCalls("deny")).toHaveLength(1));
    expect(actionCalls("deny")[0]?.body).toEqual({ requestId: "req-1" });
    await waitFor(() => expect(screen.queryByText("QRST-7890")).toBeNull());
    expect(actionCalls("approve")).toHaveLength(0);
  });

  test("action buttons disable while an action is in flight", async () => {
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
  });

  test("stays hidden with the card when there is no local gateway", () => {
    gatewayPath = undefined;
    installPendingFetch();
    const { container } = render(<PairDeviceCard />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pairing requests")).toBeNull();
    // The gate keeps the poll from ever firing.
    expect(requests).toHaveLength(0);
  });

  test("stays hidden with the card when web-remote-ingress is off", () => {
    webRemoteIngressOn = false;
    installPendingFetch();
    const { container } = render(<PairDeviceCard />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Pairing requests")).toBeNull();
    expect(requests).toHaveLength(0);
  });
});
