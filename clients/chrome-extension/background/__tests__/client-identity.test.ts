import { afterEach, describe, expect, test } from "bun:test";

function installChromeMock(version = "0.12.1"): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getManifest: () => ({ version }),
    },
    storage: {
      local: {
        async get() {
          return { "vellum.clientId": "client-123" };
        },
        async set() {
          /* no-op */
        },
      },
    },
  };
}

describe("getClientRegistrationHeaders", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  test("sends version and watchdog fingerprint with identity headers", async () => {
    installChromeMock("0.12.1");
    const { getClientRegistrationHeaders } = await import(
      "../client-identity.js"
    );

    const headers = await getClientRegistrationHeaders();
    expect(headers["X-Vellum-Client-Id"]).toBe("client-123");
    expect(headers["X-Vellum-Interface-Id"]).toBe("chrome-extension");
    expect(headers["X-Vellum-Client-Version"]).toBe("0.12.1");
    expect(headers["X-Vellum-Sse-Watchdog"]).toBe("1");
  });
});
