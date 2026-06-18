import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
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
  RemoteWebPairingError: class RemoteWebPairingError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
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

    expect(screen.getByText("Not found")).not.toBeNull();
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
    expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
      "created-device",
    );
  });
});
