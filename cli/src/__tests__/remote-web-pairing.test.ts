import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  createRemoteWebPairingCode,
  printRemoteWebPairingInstructions,
} from "../lib/remote-web-pairing.js";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalWarn = console.warn;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.warn = originalWarn;
});

describe("remote web pairing CLI helper", () => {
  test("requests a pairing code from the local gateway", async () => {
    const fetchMock = mock(async (_input: string, _init?: RequestInit) => {
      return Response.json({
        code: "123-456",
        expiresAt: "2026-06-15T20:00:00.000Z",
        expiresInSeconds: 600,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const code = await createRemoteWebPairingCode({
      gatewayPort: 7830,
      publicBaseUrl: "https://paired.example.com",
    });

    expect(code).toEqual({
      code: "123-456",
      expiresAt: "2026-06-15T20:00:00.000Z",
      expiresInSeconds: 600,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7830/v1/remote-web/pairing-code");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({
        publicBaseUrl: "https://paired.example.com",
      }),
    );
  });

  test("prints the assistant URL and code when remote web pairing is enabled", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        code: "123-456",
        expiresAt: "2026-06-15T20:00:00.000Z",
        expiresInSeconds: 600,
      }),
    ) as unknown as typeof globalThis.fetch;
    const logMock = mock((_message?: unknown) => {});
    console.log = logMock as unknown as typeof console.log;

    await printRemoteWebPairingInstructions({
      gatewayPort: 7830,
      publicBaseUrl: "https://paired.example.com",
      enabled: true,
    });

    const output = logMock.mock.calls.map((call) => String(call[0] ?? ""));
    expect(output).toContain(
      "Remote web app: https://paired.example.com/assistant/",
    );
    expect(output).toContain("Pairing code:   123-456");
  });

  test("does not request a code when remote web pairing is disabled", async () => {
    const fetchMock = mock(async () => Response.json({}));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await printRemoteWebPairingInstructions({
      gatewayPort: 7830,
      publicBaseUrl: "https://paired.example.com",
      enabled: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("warns instead of failing the tunnel when code creation fails", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "nope" }, { status: 500 }),
    ) as unknown as typeof globalThis.fetch;
    const warnMock = mock((_message?: unknown) => {});
    console.warn = warnMock as unknown as typeof console.warn;

    await printRemoteWebPairingInstructions({
      gatewayPort: 7830,
      publicBaseUrl: "https://paired.example.com",
      enabled: true,
    });

    const output = warnMock.mock.calls.map((call) => String(call[0] ?? ""));
    expect(output.some((line) => line.includes("could not create"))).toBe(true);
  });
});
