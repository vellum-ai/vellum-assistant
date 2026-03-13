import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { callTelegramApi } = await import("../telegram/api.js");

/** Create a mock ConfigFileCache that returns 0 retries to avoid delay in tests. */
function makeConfigFile(): ConfigFileCache {
  return {
    getNumber: (_section: string, field: string) => {
      if (field === "maxRetries") return 0;
      if (field === "timeoutMs") return 15000;
      if (field === "initialBackoffMs") return 1000;
      return undefined;
    },
    getString: () => undefined,
    getBoolean: () => undefined,
    getRecord: () => undefined,
  } as unknown as ConfigFileCache;
}

/** Create a mock CredentialCache that returns the given bot token. */
function makeCredentials(botToken: string): CredentialCache {
  return {
    get: async (key: string) => {
      if (key === credentialKey("telegram", "bot_token")) return botToken;
      return undefined;
    },
    invalidate: () => {},
  } as unknown as CredentialCache;
}

describe("callTelegramApi transport error redaction", () => {
  afterEach(() => {
    fetchMock = mock(async () => new Response());
  });

  test("redacts bot token from warning logs and thrown error", async () => {
    const tgToken = [
      "123456789",
      ":",
      "ABCDefGHIJklmnopQRSTuvwxyz012345678",
    ].join("");

    fetchMock = mock(async () => {
      const err = new Error(
        "Unable to connect. Is the computer able to access the url?",
      ) as Error & {
        path?: string;
        code?: string;
      };
      err.path = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      err.code = "ConnectionRefused";
      throw err;
    });

    let thrown: Error | null = null;
    try {
      await callTelegramApi(
        "sendMessage",
        {
          chat_id: "1",
          text: "hello",
        },
        { credentials: makeCredentials(tgToken), configFile: makeConfigFile() },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(tgToken);
    expect(thrown?.message).toContain("[REDACTED]");
  });

  test("redacts bot token preceded by hyphen delimiter", async () => {
    // Tokens embedded after a hyphen (e.g., diagnostic strings like
    // "error-123456789:...") must still be redacted.
    const tgToken = [
      "123456789",
      ":",
      "ABCDefGHIJklmnopQRSTuvwxyz012345678",
    ].join("");

    fetchMock = mock(async () => {
      const err = new Error("Connection refused") as Error & {
        path?: string;
        code?: string;
      };
      // Simulate a diagnostic string where the token is preceded by a hyphen
      err.path = `prefix-${tgToken}/sendMessage`;
      err.code = "ConnectionRefused";
      throw err;
    });

    let thrown: Error | null = null;
    try {
      await callTelegramApi(
        "sendMessage",
        {
          chat_id: "1",
          text: "hello",
        },
        { credentials: makeCredentials(tgToken), configFile: makeConfigFile() },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(tgToken);
    expect(thrown?.message).toContain("[REDACTED]");
  });

  test("redacts bot token ending with hyphen", async () => {
    // Tokens can end with `-` which is a non-word character; \b boundaries
    // would fail to match the trailing `-`, leaking part of the token.
    const tgToken = [
      "123456789",
      ":",
      "ABCDefGHIJklmnopQRSTuvwxyz01234567-",
    ].join("");

    fetchMock = mock(async () => {
      const err = new Error("Connection refused") as Error & {
        path?: string;
        code?: string;
      };
      err.path = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      err.code = "ConnectionRefused";
      throw err;
    });

    let thrown: Error | null = null;
    try {
      await callTelegramApi(
        "sendMessage",
        {
          chat_id: "1",
          text: "hello",
        },
        { credentials: makeCredentials(tgToken), configFile: makeConfigFile() },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toContain(tgToken);
    expect(thrown?.message).toContain("[REDACTED]");
  });
});
