import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/runtime/local-mode-host";

mock.module("@/generated/api/client.gen", () => ({ client: {} }));
mock.module("@/lib/local-mode", () => ({
  getLocalGatewayUrl: () => "/assistant/__gateway/7821",
}));
mock.module("@/runtime/local-mode-host", () => ({
  fetchGuardianTokenHost: async () => "guardian-token",
}));

const { createLocalBackup } = await import("./teleport-gateway-client");

const LOCAL = {
  assistantId: "ast-local",
  cloud: "local",
} as unknown as LockfileAssistant;

let originalFetch: typeof globalThis.fetch;
let calls: Array<{ url: string; body: unknown }>;
let createResponse: () => Response;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  createResponse = () => Response.json({ success: true, local: {} });
  globalThis.fetch = mock(
    async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push({
        url: urlStr,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (urlStr.endsWith("/auth/token")) {
        return Response.json({ token: "gateway-token" });
      }
      return createResponse();
    },
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createLocalBackup", () => {
  test("posts to the gateway snapshot route with the minted token", async () => {
    await createLocalBackup(LOCAL);

    const create = calls.find((c) => c.url.endsWith("/v1/backups/create"));
    expect(create).toBeDefined();
    expect(create?.body).toBeNull();
  });

  test("fails on a non-2xx status", async () => {
    createResponse = () => new Response("boom", { status: 500 });

    await expect(createLocalBackup(LOCAL)).rejects.toThrow(
      "Backup failed (HTTP 500).",
    );
  });

  test("fails on a body reporting failure", async () => {
    createResponse = () => Response.json({ success: false });

    await expect(createLocalBackup(LOCAL)).rejects.toThrow(
      "Backup reported failure.",
    );
  });
});
