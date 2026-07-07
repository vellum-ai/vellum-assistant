import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

let remoteGatewayMode = false;

mock.module("@/lib/local-mode", () => ({
  isRemoteGatewayMode: () => remoteGatewayMode,
}));

const exchangeRemoteWebPairingTokenMock = mock(
  async (_deviceCode: string, _signal?: AbortSignal) => ({
    status: "pending",
    expiresAt: "2026-06-16T12:00:00.000Z",
    intervalSeconds: 5,
  }),
);
const createRemoteWebPairingChallengeMock = mock(
  async (_signal?: AbortSignal) => ({
    deviceCode: "created-device",
    userCode: "B8C2-S2J3",
    verificationUri: "http://localhost:3000/assistant/pair",
    expiresAt: "2026-06-16T12:00:00.000Z",
    expiresInSeconds: 600,
    intervalSeconds: 5,
  }),
);

class MockRemoteWebPairingError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

mock.module("@/lib/auth/remote-gateway-session", () => ({
  activateRemoteGatewaySession: () => {},
  createRemoteWebPairingChallenge: createRemoteWebPairingChallengeMock,
  exchangeRemoteWebPairingToken: exchangeRemoteWebPairingTokenMock,
  parseRemoteWebPairingParams: (value: string) => {
    const url = new URL(value, "http://localhost:3000");
    return {
      deviceCode: url.searchParams.get("deviceCode"),
      userCode: url.searchParams.get("userCode"),
    };
  },
  RemoteWebPairingError: MockRemoteWebPairingError,
}));

const { RemoteWebPairingPage } =
  await import("@/domains/remote-web/pairing-page");

afterEach(() => {
  cleanup();
  remoteGatewayMode = false;
  exchangeRemoteWebPairingTokenMock.mockClear();
  createRemoteWebPairingChallengeMock.mockClear();
});

describe("RemoteWebPairingPage", () => {
  test("renders NotFound outside remote-gateway mode", () => {
    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Page not found")).not.toBeNull();
    expect(createRemoteWebPairingChallengeMock).not.toHaveBeenCalled();
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
  });

  test("polls for a token in remote-gateway mode", async () => {
    remoteGatewayMode = true;

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Waiting for approval")).not.toBeNull();
    expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
      "device-1",
    );
    expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[1]).toBeInstanceOf(
      AbortSignal,
    );
    expect(createRemoteWebPairingChallengeMock).not.toHaveBeenCalled();
  });

  test("shows progress state while creating a challenge", () => {
    remoteGatewayMode = true;
    createRemoteWebPairingChallengeMock.mockImplementationOnce(
      async () => new Promise<never>(() => {}),
    );

    const { container } = render(
      <MemoryRouter initialEntries={["/assistant/pair"]}>
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Starting pairing")).not.toBeNull();
    expect(
      container.querySelector(".animate-spin.text-blue-600"),
    ).not.toBeNull();
    expect(container.querySelector(".text-red-600")).toBeNull();
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
  });

  test("creates a challenge when opened without a device code", async () => {
    remoteGatewayMode = true;

    render(
      <MemoryRouter initialEntries={["/assistant/pair"]}>
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("B8C2-S2J3")).not.toBeNull();
    expect(
      createRemoteWebPairingChallengeMock.mock.calls[0]?.[0],
    ).toBeInstanceOf(AbortSignal);
    // The token-exchange poll fires in an effect after the challenge resolves
    // and `pairing` is set, so it lands a tick after the user code renders.
    await waitFor(() => {
      expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
        "created-device",
      );
    });
  });

  test("surfaces guardian-repair guidance on a repair-required exchange failure", async () => {
    remoteGatewayMode = true;
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(async () => {
      throw new MockRemoteWebPairingError(
        503,
        "Pairing token exchange failed: 503",
        "GUARDIAN_REPAIR_REQUIRED",
      );
    });

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Pairing failed")).not.toBeNull();
    expect(screen.getByText(/trust database needs repair/)).not.toBeNull();
    expect(screen.getByText(/retry this same pairing link/)).not.toBeNull();
    expect(screen.queryByText(/starting a new pairing/)).toBeNull();
  });

  test("keeps new-pairing guidance for other exchange failures", async () => {
    remoteGatewayMode = true;
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(async () => {
      throw new MockRemoteWebPairingError(
        503,
        "Pairing token exchange failed: 503",
      );
    });

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Pairing failed")).not.toBeNull();
    expect(screen.getByText(/Try starting a new pairing/)).not.toBeNull();
    expect(screen.queryByText(/trust database needs repair/)).toBeNull();
  });
});
