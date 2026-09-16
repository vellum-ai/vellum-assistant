import { describe, expect, mock, test } from "bun:test";

import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import "../__tests__/test-preload.js";

const calls: string[] = [];
let getMeResponse: () => Promise<unknown> = async () => ({
  id: 123456789,
  username: "vellum_bot",
});

// Spread the actual module so untouched exports keep resolving when the
// import graph grows.
const actualApi = await import("./api.js");
mock.module("./api.js", () => ({
  ...actualApi,
  callTelegramApi: async (method: string) => {
    calls.push(method);
    return getMeResponse();
  },
}));

const {
  botUserIdFromToken,
  createTelegramBotIdentityResolver,
  DEGRADED_IDENTITY_RETRY_MS,
} = await import("./bot-identity.js");

function credentials(token: string | undefined): CredentialCache {
  return {
    get: async (key: string) =>
      key === credentialKey("telegram", "bot_token") ? token : undefined,
    invalidate: () => {},
  } as unknown as CredentialCache;
}

describe("botUserIdFromToken", () => {
  test("reads the id before the colon", () => {
    expect(
      botUserIdFromToken("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"),
    ).toBe("123456");
  });

  test("answers nothing for a token without that shape", () => {
    expect(botUserIdFromToken("not-a-token")).toBeUndefined();
    expect(botUserIdFromToken(":secret")).toBeUndefined();
  });
});

describe("createTelegramBotIdentityResolver", () => {
  test("resolves from getMe once and reuses it for the same token", async () => {
    calls.length = 0;
    const resolve = createTelegramBotIdentityResolver({
      credentials: credentials("123456789:secret"),
    });
    expect(await resolve()).toEqual({
      userId: "123456789",
      username: "vellum_bot",
    });
    expect(await resolve()).toEqual({
      userId: "123456789",
      username: "vellum_bot",
    });
    expect(calls).toEqual(["getMe"]);
  });

  test("falls back to the token's id when getMe fails, then retries after the window", async () => {
    // Replies and text mentions still admit on the id alone; username
    // mentions go unrecognised only until the next successful resolve, which
    // the next room update after the window triggers.
    calls.length = 0;
    let clock = 1_000_000;
    getMeResponse = async () => {
      throw new Error("Telegram getMe failed with status 502");
    };
    const resolve = createTelegramBotIdentityResolver(
      { credentials: credentials("123456789:secret") },
      () => clock,
    );
    expect(await resolve()).toEqual({ userId: "123456789" });

    // Inside the window the degraded identity is reused without a call.
    clock += DEGRADED_IDENTITY_RETRY_MS - 1;
    expect(await resolve()).toEqual({ userId: "123456789" });
    expect(calls).toEqual(["getMe"]);

    // Past it, getMe runs again and the full identity replaces the fallback.
    getMeResponse = async () => ({ id: 123456789, username: "vellum_bot" });
    clock += 1;
    expect(await resolve()).toEqual({
      userId: "123456789",
      username: "vellum_bot",
    });
    expect(calls).toEqual(["getMe", "getMe"]);

    // A full identity is held for the token's lifetime.
    clock += DEGRADED_IDENTITY_RETRY_MS * 10;
    await resolve();
    expect(calls).toEqual(["getMe", "getMe"]);
  });

  test("answers nothing without a token", async () => {
    const resolve = createTelegramBotIdentityResolver({
      credentials: credentials(undefined),
    });
    expect(await resolve()).toBeUndefined();
  });

  test("a rotated token re-resolves", async () => {
    calls.length = 0;
    let token = "1:first";
    const resolve = createTelegramBotIdentityResolver({
      credentials: credentials(token),
    });
    await resolve();
    token = "2:second";
    const rotated = createTelegramBotIdentityResolver({
      credentials: credentials(token),
    });
    await rotated();
    expect(calls).toEqual(["getMe", "getMe"]);
  });
});
