import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mockStoredKeys: Record<string, string> = {};

mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => mockStoredKeys[key],
}));

import {
  mapVelayError,
  probeVelayRejection,
  resolveVelaySpeechConnection,
} from "../vellum-velay-connection.js";

const KEY = "credential/vellum/assistant_api_key";

describe("resolveVelaySpeechConnection", () => {
  const originalEnv = process.env.VELAY_BASE_URL;

  beforeEach(() => {
    mockStoredKeys = {};
    delete process.env.VELAY_BASE_URL;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VELAY_BASE_URL;
    } else {
      process.env.VELAY_BASE_URL = originalEnv;
    }
  });

  test("returns null without a stored assistant API key", async () => {
    expect(await resolveVelaySpeechConnection()).toBeNull();
  });

  test("defaults to the production velay origin", async () => {
    mockStoredKeys = { [KEY]: "vk-1" };
    expect(await resolveVelaySpeechConnection()).toEqual({
      wsBaseUrl: "wss://velay.vellum.ai",
      httpBaseUrl: "https://velay.vellum.ai",
      apiKey: "vk-1",
    });
  });

  test("honors VELAY_BASE_URL and converts the ws scheme", async () => {
    mockStoredKeys = { [KEY]: "vk-1" };
    process.env.VELAY_BASE_URL = "http://localhost:8484/";
    expect(await resolveVelaySpeechConnection()).toEqual({
      wsBaseUrl: "ws://localhost:8484",
      httpBaseUrl: "http://localhost:8484",
      apiKey: "vk-1",
    });
  });
});

describe("mapVelayError", () => {
  test("maps the contract's codes onto categories", () => {
    expect(mapVelayError({ code: "invalid_key" }).category).toBe("auth");
    expect(mapVelayError({ code: "insufficient_balance" })).toMatchObject({
      category: "provider-error",
      message: expect.stringContaining("credits"),
    });
    expect(mapVelayError({ code: "provider_unreachable" }).category).toBe(
      "provider-error",
    );
    expect(mapVelayError({ code: "upstream_error" }).category).toBe(
      "provider-error",
    );
    expect(mapVelayError({ code: "novel_code", detail: "what" })).toMatchObject(
      {
        category: "provider-error",
        message: expect.stringContaining("novel_code"),
      },
    );
  });
});

describe("probeVelayRejection", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns the JSON rejection body", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "invalid_key", detail: "nope" }), {
        status: 401,
      })) as unknown as typeof fetch;

    expect(await probeVelayRejection("https://velay.test/x")).toEqual({
      code: "invalid_key",
      detail: "nope",
    });
  });

  test("returns null when the gate passes (non-JSON upgrade failure)", async () => {
    globalThis.fetch = (async () =>
      new Response("Upgrade Required", {
        status: 426,
      })) as unknown as typeof fetch;

    expect(await probeVelayRejection("https://velay.test/x")).toBeNull();
  });

  test("returns null when the probe itself fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;

    expect(await probeVelayRejection("https://velay.test/x")).toBeNull();
  });
});
