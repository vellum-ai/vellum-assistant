import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ── Mutable state for injected vault ────────────────────────────────────────

const vaultStore = new Map<string, string>();
const writtenKeys = new Map<string, string>();

// ── Import under test ────────────────────────────────────────────────────────
//
// No mock.module — prevents all bun worker contamination. Vault access is
// injected through _injectVaultAccessors / _resetVaultAccessors instead.

const {
  getValidServiceAccountToken,
  parseServiceAccountKey,
  _resetServiceAccountMutex,
  _injectVaultAccessors,
  _resetVaultAccessors,
} = await import("../providers/inference/service-account-token.js");

// ── Hooks ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vaultStore.clear();
  writtenKeys.clear();
  _resetServiceAccountMutex();
  _injectVaultAccessors(
    async (key: string) => vaultStore.get(key),
    async (key: string, value: string) => {
      vaultStore.set(key, value);
      writtenKeys.set(key, value);
      return true;
    },
  );
});

afterEach(() => {
  _resetVaultAccessors();
});

// ── Real 2048-bit RSA PKCS#8 key generated offline for unit tests only ───────

const TEST_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\n" +
  "MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDFnEC0wI/cNKyO\n" +
  "XzkqOGAvsTTx4Q+DPjDBPVoy3yHVk7cGYIf5sg3nsrQlE4ARMEQ9MXKUvw+VY59c\n" +
  "zzpy9/JnCN9v5ymZUrowF/87Xn0muklHOhYPFz+73BunncH0Dk0mgCRWEfd/xoGB\n" +
  "bMI40mI2hPMN5aGU4moTmVzTsgvatp0tAk90oaUQBZ/Y3PVjoR+SHbKhQtZW8eiO\n" +
  "zUGyBhzmlmMZcquWxHui8QbO//kEKg7jv2+7npkdW/S0meoDeKZzqRNACKci1CQB\n" +
  "N/skFqy6B8qYekhVYtAaIQOLtuD+VdLL7azMBqIHZSVQQXD6KisN8XSj95k/Fyeb\n" +
  "UEmhvlwrAgMBAAECggEALKr7PWBhpGcLskr4AwEnTOCDlUFIXmRKZQPXRbSGU17G\n" +
  "elyLn/eNiRgt/EuCIWCFrEdnHRRrE1unhDUbgy1kz8GDsCnSj2PRzlk+Sk87fuuQ\n" +
  "8NbCcbrRn0dLwQG5+87XxaIllIcPKQTX9Ud+R5XWuXgn8LY9Zggf7jo2b2vJnjBO\n" +
  "2SIS4M24a8x/1hHLjrTKtyO1yF3TI/9z72z4+yYiXAHxBugCcg6kv27pMEtOl5hv\n" +
  "HW6ogBIDKVIVp3DmjaWxPawy1ytxpI1mR1lfGKoNI3iutLNfuHl3MwinYL7oCiL/\n" +
  "rejuz37rXicFZ40YTKHDqKy+brLS6Ahg0R7XxSNtcQKBgQD7i4oh4stD+geFoPoJ\n" +
  "o/grtOazn2GKuMOrcbBSaTfs4PZfcSRT8Egzhl3Vf/3Z30T3ChugFKkpN9naDEL3\n" +
  "0SEH5sR5oMhGzzE3ncwTPR4fClpiX61JIY6iVL5AQukXIK+v+hCuhRu9YepMbGWq\n" +
  "ndl/uH4LofuEctJYaovnghKedwKBgQDJHC7NiqNhGB6YzwgvYK2GVrFLdPpcfLbl\n" +
  "y5DZKaVYCs3cLFCH7qHEdsmVEWkQ9UkRhxNPGpgQadvYNAd9Bbf2au2lfNuCt0Kn\n" +
  "dYDgkxHAo4PByEznOBgQYoG5IjF8bdubQJbJHQh/bj5EkzeKDggD37ED0fTdWIiJ\n" +
  "Nhh0/q2Y7QKBgGlLMsoWbjGJMqbcCG4KpfJdqghcWe9Agh982mrUwmU0kczHxoYg\n" +
  "WYi/4P1iszcE/5BNOd0baOfpChb89PdZIfN1xJ6JD+ycBCUct3UCK16g7c6p8BZh\n" +
  "ppwKzwyFNZ7JvuDx0xPKgh8XIoVVBoWRx55v8ssZxffePHBoQSHqT7LnAoGAB1vO\n" +
  "opq2C7F0PScmJ4WkE8xMRHSNTKELmDDwpeGOOUB789hzQeYLaULncVrnu0UeXVPR\n" +
  "8w0ID2GwN6L/uyVga9XRyEJfTdMizznPc2guOBxDj+2iUruMtdzE3l9P7Dug03dz\n" +
  "jPxQ+UixYpT4bUbCKFIhCgC+svKwXETsdCt1cqkCgYBVSSabJNSvFfqYz/VJbRK7\n" +
  "cvxEr3mcV/I/+5BoyTmTKQGkIRl6xCMhqZk019hXbdN66jMQ9zg6wni4UKA43cXI\n" +
  "/3NHY86IvdpLORlYqKVHycZsqSVQE6Z3V1G4C2wVKUZtWsoT6Wr+Ind+V+VzbDD2\n" +
  "wHbW4FhxHN9iwdHfmJyq+g==\n" +
  "-----END PRIVATE KEY-----\n";

const TEST_SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  client_email: "test@example.com",
  private_key: TEST_PRIVATE_KEY,
  token_uri: "https://oauth2.googleapis.com/token",
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("service-account-token", () => {
  // -- parseServiceAccountKey ------------------------------------------------

  describe("parseServiceAccountKey", () => {
    test("returns null for empty string", () => {
      expect(parseServiceAccountKey("")).toBeNull();
    });

    test("returns null for invalid JSON", () => {
      expect(parseServiceAccountKey("not-json")).toBeNull();
    });

    test("returns null when required fields are missing", () => {
      expect(
        parseServiceAccountKey(
          JSON.stringify({ client_email: "test@example.com" }),
        ),
      ).toBeNull();
    });

    test("returns the key when all required fields are present", () => {
      const key = parseServiceAccountKey(TEST_SERVICE_ACCOUNT);
      expect(key).not.toBeNull();
      expect(key?.client_email).toBe("test@example.com");
    });
  });

  // -- getValidServiceAccountToken -------------------------------------------

  test("returns not_found when no credential is stored", async () => {
    const result = await getValidServiceAccountToken("credential/vertex-ai");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  test("returns invalid_config when credential is not valid JSON", async () => {
    vaultStore.set("credential/vertex-ai", "not-json");
    const result = await getValidServiceAccountToken("credential/vertex-ai");
    expect(result).toEqual({ ok: false, reason: "invalid_config" });
  });

  test("returns invalid_config when credential JSON is missing required fields", async () => {
    vaultStore.set(
      "credential/vertex-ai",
      JSON.stringify({ client_email: "missing-other-fields@example.com" }),
    );
    const result = await getValidServiceAccountToken("credential/vertex-ai");
    expect(result).toEqual({ ok: false, reason: "invalid_config" });
  });

  test("returns cached token when the cache blob is still fresh", async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 7200;
    vaultStore.set("credential/vertex-ai", TEST_SERVICE_ACCOUNT);
    vaultStore.set(
      "credential/vertex-ai/token_cache",
      JSON.stringify({
        access_token: "cached-token",
        expires_at: futureExpiry,
      }),
    );

    const result = await getValidServiceAccountToken("credential/vertex-ai");
    expect(result).toEqual({ ok: true, token: "cached-token" });
    // Nothing new should have been written (no exchange performed).
    expect(writtenKeys.size).toBe(0);
  });

  test("returns cached token when cache blob has no expiry", async () => {
    vaultStore.set("credential/vertex-ai", TEST_SERVICE_ACCOUNT);
    vaultStore.set(
      "credential/vertex-ai/token_cache",
      JSON.stringify({ access_token: "no-expiry-token" }),
    );

    const result = await getValidServiceAccountToken("credential/vertex-ai");
    expect(result).toEqual({ ok: true, token: "no-expiry-token" });
  });

  test("coalesces concurrent callers for the same credential onto one exchange", async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 600;
    vaultStore.set("credential/vertex-ai", TEST_SERVICE_ACCOUNT);
    vaultStore.set(
      "credential/vertex-ai/token_cache",
      JSON.stringify({ access_token: "stale-token", expires_at: pastExpiry }),
    );

    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCallCount += 1;
      return {
        ok: true,
        json: async () => ({ access_token: "new-token", expires_in: 3600 }),
      } as Response;
    }) as unknown as typeof fetch;

    try {
      const [r1, r2] = await Promise.all([
        getValidServiceAccountToken("credential/vertex-ai"),
        getValidServiceAccountToken("credential/vertex-ai"),
      ]);

      expect(r1).toEqual({ ok: true, token: "new-token" });
      expect(r2).toEqual({ ok: true, token: "new-token" });
      expect(fetchCallCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("concurrent callers for different credentials exchange independently", async () => {
    vaultStore.set("credential/vertex-a", TEST_SERVICE_ACCOUNT);
    vaultStore.set("credential/vertex-b", TEST_SERVICE_ACCOUNT);

    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCallCount += 1;
      return {
        ok: true,
        json: async () => ({
          access_token: `token-${fetchCallCount}`,
          expires_in: 3600,
        }),
      } as Response;
    }) as unknown as typeof fetch;

    try {
      const [r1, r2] = await Promise.all([
        getValidServiceAccountToken("credential/vertex-a"),
        getValidServiceAccountToken("credential/vertex-b"),
      ]);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      // Each credential triggers its own exchange.
      expect(fetchCallCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("caches token+expiry as a single JSON blob", async () => {
    vaultStore.set("credential/vertex-ai", TEST_SERVICE_ACCOUNT);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ access_token: "fresh-token", expires_in: 3600 }),
    })) as unknown as typeof fetch;

    try {
      await getValidServiceAccountToken("credential/vertex-ai");

      const blob = vaultStore.get("credential/vertex-ai/token_cache");
      expect(blob).toBeDefined();
      const parsed = JSON.parse(blob!) as {
        access_token: string;
        expires_at: number;
      };
      expect(parsed.access_token).toBe("fresh-token");
      expect(typeof parsed.expires_at).toBe("number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
