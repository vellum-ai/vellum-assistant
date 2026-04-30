import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CodexCredentials } from "../providers/openai/codex-oauth.js";
import { credentialKey } from "../security/credential-key.js";

const STORAGE_KEY = credentialKey("openai_codex_oauth", "blob");

const secureKeyStore: Record<string, string> = {};

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => secureKeyStore[key],
  setSecureKeyAsync: async (key: string, value: string) => {
    secureKeyStore[key] = value;
    return true;
  },
  deleteSecureKeyAsync: async (key: string) => {
    delete secureKeyStore[key];
    return "ok" as const;
  },
}));

const refreshMock = mock(
  async (_refreshToken: string): Promise<CodexCredentials> => {
    throw new Error("refresh not stubbed");
  },
);

mock.module("../providers/openai/codex-oauth.js", () => ({
  refreshOpenAICodexToken: refreshMock,
}));

const {
  getOpenAICodexCredentials,
  setOpenAICodexCredentials,
  clearOpenAICodexCredentials,
} = await import("../providers/openai/codex-credentials.js");

function blobOf(creds: CodexCredentials): string {
  return Buffer.from(JSON.stringify(creds), "utf8").toString("base64");
}

const FRESH: CodexCredentials = {
  access: "access-fresh",
  refresh: "refresh-1",
  expiresAt: Date.now() + 60 * 60 * 1000,
  accountId: "account-1",
};

const NEAR_EXPIRY: CodexCredentials = {
  access: "access-stale",
  refresh: "refresh-1",
  expiresAt: Date.now() + 5_000,
  accountId: "account-1",
};

beforeEach(() => {
  for (const key of Object.keys(secureKeyStore)) delete secureKeyStore[key];
  refreshMock.mockReset();
});

afterEach(() => {
  refreshMock.mockReset();
});

describe("codex-credentials persistence", () => {
  test("returns undefined when no blob is stored", async () => {
    expect(await getOpenAICodexCredentials()).toBeUndefined();
  });

  test("setOpenAICodexCredentials writes a base64 JSON blob at credentialKey path", async () => {
    await setOpenAICodexCredentials(FRESH);
    const raw = secureKeyStore[STORAGE_KEY];
    expect(raw).toBeDefined();
    expect(JSON.parse(Buffer.from(raw!, "base64").toString("utf8"))).toEqual(
      FRESH,
    );
  });

  test("getOpenAICodexCredentials round-trips a stored blob", async () => {
    secureKeyStore[STORAGE_KEY] = blobOf(FRESH);
    const got = await getOpenAICodexCredentials();
    expect(got).toEqual(FRESH);
  });

  test("clearOpenAICodexCredentials deletes the blob", async () => {
    await setOpenAICodexCredentials(FRESH);
    expect(secureKeyStore[STORAGE_KEY]).toBeDefined();
    await clearOpenAICodexCredentials();
    expect(secureKeyStore[STORAGE_KEY]).toBeUndefined();
  });

  test("returns undefined when blob is not valid base64/JSON", async () => {
    secureKeyStore[STORAGE_KEY] = "not-base64!@#";
    expect(await getOpenAICodexCredentials()).toBeUndefined();

    secureKeyStore[STORAGE_KEY] = Buffer.from("not json", "utf8").toString(
      "base64",
    );
    expect(await getOpenAICodexCredentials()).toBeUndefined();
  });

  test("returns undefined when blob is missing required fields", async () => {
    secureKeyStore[STORAGE_KEY] = Buffer.from(
      JSON.stringify({ access: "a", refresh: "b" }),
      "utf8",
    ).toString("base64");
    expect(await getOpenAICodexCredentials()).toBeUndefined();
  });
});

describe("codex-credentials refresh", () => {
  test("does not refresh when token is far from expiry", async () => {
    secureKeyStore[STORAGE_KEY] = blobOf(FRESH);
    const got = await getOpenAICodexCredentials();
    expect(got).toEqual(FRESH);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("refreshes when token is within the buffer window", async () => {
    secureKeyStore[STORAGE_KEY] = blobOf(NEAR_EXPIRY);
    const refreshed: CodexCredentials = {
      ...NEAR_EXPIRY,
      access: "access-refreshed",
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    refreshMock.mockImplementation(async () => refreshed);

    const got = await getOpenAICodexCredentials();
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(got).toEqual(refreshed);
    // Refreshed blob is persisted.
    const persisted = JSON.parse(
      Buffer.from(secureKeyStore[STORAGE_KEY]!, "base64").toString("utf8"),
    );
    expect(persisted).toEqual(refreshed);
  });

  test("single-flight dedupes concurrent refresh callers", async () => {
    secureKeyStore[STORAGE_KEY] = blobOf(NEAR_EXPIRY);
    let resolveRefresh!: (creds: CodexCredentials) => void;
    const pending = new Promise<CodexCredentials>((resolve) => {
      resolveRefresh = resolve;
    });
    refreshMock.mockImplementation(() => pending);

    const a = getOpenAICodexCredentials();
    const b = getOpenAICodexCredentials();
    const c = getOpenAICodexCredentials();
    // Drain microtasks so all three callers reach the inflightRefresh check
    // before we resolve the deferred promise.
    await Promise.resolve();
    await Promise.resolve();

    const refreshed: CodexCredentials = {
      ...NEAR_EXPIRY,
      access: "access-refreshed",
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    resolveRefresh(refreshed);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(ra).toEqual(refreshed);
    expect(rb).toEqual(refreshed);
    expect(rc).toEqual(refreshed);
  });

  test("forceRefresh returns undefined on refresh failure (no stale fallback)", async () => {
    secureKeyStore[STORAGE_KEY] = blobOf(FRESH);
    refreshMock.mockImplementation(async () => {
      throw new Error("refresh upstream 401");
    });

    const got = await getOpenAICodexCredentials({ forceRefresh: true });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(got).toBeUndefined();
  });

  test("non-forced refresh falls back to stored creds when refresh fails", async () => {
    secureKeyStore[STORAGE_KEY] = blobOf(NEAR_EXPIRY);
    refreshMock.mockImplementation(async () => {
      throw new Error("transient network blip");
    });

    const got = await getOpenAICodexCredentials();
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(got).toEqual(NEAR_EXPIRY);
  });
});
