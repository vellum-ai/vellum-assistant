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

mock.module("@/lib/auth/remote-gateway-session", () => ({
  activateRemoteGatewaySession: () => {},
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
  });
});
