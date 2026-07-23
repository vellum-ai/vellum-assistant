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

mock.module("@/lib/local-mode", () => ({
  getLocalGatewayUrl: () => gatewayPath,
  getSelectedAssistant: () => ({ assistantId: "self", cloud: "local" }),
}));

mock.module("@/lib/backwards-compat/remote-web-pairing-gate", () => ({
  useSupportsRemoteWebPairing: () => supportsPairingRoutes,
}));

mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: { webRemoteIngress: () => webRemoteIngressOn },
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

/** Install a fetch mock that records requests and answers per route. */
function installFetch(
  onChallenge: () => Response,
  onVerification: () => Response = () =>
    jsonResponse({
      status: "approved",
      verificationUri: "https://foo.ts.net/assistant/pair",
      expiresAt: futureIso(),
    }),
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
    throw new Error(`unexpected fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
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
  requests = [];
  localStorage.clear();
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

  test("reports the enable guidance without minting when web-remote-ingress is off", async () => {
    webRemoteIngressOn = false;
    const fetchMock = installFetch(() => jsonResponse(challengeBody()));
    render(<PairDeviceCard />);
    typeUrl(PUBLIC_URL);
    fireEvent.click(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "Remote web access is disabled on this assistant, so a scanned code couldn't connect.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/web-remote-ingress/)).toBeTruthy();
    // Mirrors the CLI: the flag is checked before minting, so no network call.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("mints + approves, then shows the QR and pair URL", async () => {
    const fetchMock = installFetch(() => jsonResponse(challengeBody()));
    render(<PairDeviceCard />);
    typeUrl(PUBLIC_URL);
    fireEvent.click(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    );

    await waitFor(() =>
      expect(screen.getByTitle("Device pairing QR code")).toBeTruthy(),
    );
    expect(screen.getByTestId("pair-device-url").textContent).toBe(PAIR_URL);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[0]?.url).toContain(
      "/assistant/__gateway/20100/v1/remote-web/pairing-challenge",
    );
    expect(requests[0]?.body).toEqual({ publicBaseUrl: PUBLIC_URL });
    expect(requests[1]?.url).toContain(
      "/assistant/__gateway/20100/v1/remote-web/pairing-verification",
    );
    expect(requests[1]?.body).toEqual({ userCode: "WXYZ-1234" });
  });

  test("surfaces the server's rejection message with a flag hint", async () => {
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
    expect(screen.getByText(/web-remote-ingress/)).toBeTruthy();
  });

  test("blocks a loopback URL client-side without a network call", () => {
    const fetchMock = installFetch(() => jsonResponse(challengeBody()));
    render(<PairDeviceCard />);
    typeUrl("http://localhost:3000");
    fireEvent.click(
      screen.getByRole("button", { name: "Generate pairing QR" }),
    );

    expect(
      screen.getByText(
        "This is a loopback address your phone can't reach. Enter the assistant's public https URL.",
      ),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
