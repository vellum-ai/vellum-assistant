/**
 * Route-level validation tests for base_url provider-type gate and SSRF
 * protection on inference provider connections.
 *
 * These tests exercise the POST (create) and PATCH (update) route handlers
 * with mocked DB, config, and DNS resolution.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../memory/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../memory/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../../memory/migrations/250-provider-connection-base-url-and-models.js";
import * as schema from "../../../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function bootDb() {
  const db = createTestDb();
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

// Create and hold a test DB; the mock returns it from getDb().
const testDb = bootDb();

mock.module("../../../memory/db-connection.js", () => ({
  getDb: () => testDb,
}));

mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (flag: string) =>
    flag === "openai-compatible-endpoints",
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({ llm: {} }),
  getConfigReadOnly: () => ({ llm: {} }),
}));

// Mock DNS resolution: all hostnames resolve to a public IP by default.
// Tests that need private-IP resolution override this per-test.
let mockResolvedAddresses: string[] = ["93.184.216.34"];

// Toggleable hosting mode: self-hosted (false) by default. Self-hosted daemons
// allow loopback/private base_url for openai-compatible; platform-hosted do not.
let mockIsPlatform = false;

mock.module("../../../config/env-registry.js", () => ({
  getIsPlatform: () => mockIsPlatform,
}));

// Import the real url-safety module for use inside the mock.
const {
  isPrivateOrLocalHost: realIsPrivateOrLocalHost,
  isCloudMetadataOrLinkLocalHost: realIsCloudMetadataOrLinkLocalHost,
  isPrivateIPv4,
  isPrivateIPv6,
  isIPv4,
  isIPv6,
  parseUrl,
  unwrapBracketedHostname,
  extractEmbeddedIPv4FromIPv6,
  looksLikeHostPortShorthand,
  looksLikePathOnlyInput,
  buildHostHeader,
  stripUrlUserinfo,
  sanitizeUrlForOutput,
  sanitizeUrlStringForOutput,
} = await import("../../../tools/network/url-safety.js");

mock.module("../../../tools/network/url-safety.js", () => ({
  isPrivateOrLocalHost: realIsPrivateOrLocalHost,
  isCloudMetadataOrLinkLocalHost: realIsCloudMetadataOrLinkLocalHost,
  isPrivateIPv4,
  isPrivateIPv6,
  isIPv4,
  isIPv6,
  parseUrl,
  unwrapBracketedHostname,
  extractEmbeddedIPv4FromIPv6,
  looksLikeHostPortShorthand,
  looksLikePathOnlyInput,
  buildHostHeader,
  stripUrlUserinfo,
  sanitizeUrlForOutput,
  sanitizeUrlStringForOutput,
  resolveHostAddresses: async () => mockResolvedAddresses,
  resolveRequestAddress: async (
    hostname: string,
    _resolveHost: unknown,
    allowPrivateNetwork: boolean,
  ) => {
    if (!allowPrivateNetwork && realIsPrivateOrLocalHost(hostname)) {
      return { addresses: [], blockedAddress: hostname };
    }
    const addresses = mockResolvedAddresses;
    if (!allowPrivateNetwork) {
      for (const addr of addresses) {
        if (realIsPrivateOrLocalHost(addr)) {
          return { addresses: [], blockedAddress: addr };
        }
      }
    }
    return { addresses };
  },
}));

const { ROUTES } =
  await import("../../../runtime/routes/inference-provider-connection-routes.js");

const handleCreate = ROUTES.find(
  (r) => r.operationId === "inference_provider_connections_create",
)!.handler;

const handleUpdate = ROUTES.find(
  (r) => r.operationId === "inference_provider_connections_update",
)!.handler;

// ---------------------------------------------------------------------------
// Provider-type gate: base_url rejected for non-openai-compatible providers
// ---------------------------------------------------------------------------

describe("base_url provider-type gate (create)", () => {
  test("rejects base_url on anthropic provider", async () => {
    await expect(
      handleCreate({
        body: {
          name: "exfil-anthropic",
          provider: "anthropic",
          auth: { type: "api_key", credential: "cred-exfil" },
          base_url: "https://evil.example.com/v1",
        },
      }),
    ).rejects.toThrow(/base_url is only valid for openai-compatible/);
  });

  test("rejects base_url on openai provider", async () => {
    await expect(
      handleCreate({
        body: {
          name: "exfil-openai",
          provider: "openai",
          auth: { type: "api_key", credential: "cred-exfil" },
          base_url: "https://evil.example.com/v1",
        },
      }),
    ).rejects.toThrow(/base_url is only valid for openai-compatible/);
  });

  test("rejects base_url on gemini provider", async () => {
    await expect(
      handleCreate({
        body: {
          name: "exfil-gemini",
          provider: "gemini",
          auth: { type: "api_key", credential: "cred-exfil" },
          base_url: "https://evil.example.com/v1",
        },
      }),
    ).rejects.toThrow(/base_url is only valid for openai-compatible/);
  });

  test("accepts base_url on openai-compatible provider", async () => {
    mockResolvedAddresses = ["93.184.216.34"];
    const result = await handleCreate({
      body: {
        name: "valid-oai-compat",
        provider: "openai-compatible",
        auth: { type: "api_key", credential: "cred-vllm" },
        base_url: "https://my-vllm.example.com/v1",
        models: [{ id: "my-model" }],
      },
    });
    expect(result).toBeDefined();
    expect((result as { baseUrl: string }).baseUrl).toBe(
      "https://my-vllm.example.com/v1",
    );
  });

  test("allows null base_url on non-openai-compatible provider", async () => {
    // Setting base_url to null is always allowed (it's a no-op clear).
    const result = await handleCreate({
      body: {
        name: "null-baseurl-anthropic",
        provider: "anthropic",
        auth: { type: "api_key", credential: "cred-test" },
        base_url: null,
      },
    });
    expect(result).toBeDefined();
    expect((result as { baseUrl: string | null }).baseUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SSRF protection: private/local network addresses blocked
// ---------------------------------------------------------------------------

describe("base_url SSRF protection (create)", () => {
  // Platform-hosted enforces the strict SSRF policy: private/local targets are
  // always rejected. (Self-hosted relaxation is covered by its own block.)
  beforeEach(() => {
    mockIsPlatform = true;
  });

  test("rejects private IP (192.168.x.x)", async () => {
    await expect(
      handleCreate({
        body: {
          name: "ssrf-private-ip",
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-ssrf" },
          base_url: "http://192.168.1.1/v1",
          models: [{ id: "m" }],
        },
      }),
    ).rejects.toThrow(/private or local network/);
  });

  test("rejects localhost", async () => {
    await expect(
      handleCreate({
        body: {
          name: "ssrf-localhost",
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-ssrf" },
          base_url: "http://localhost:8080/v1",
          models: [{ id: "m" }],
        },
      }),
    ).rejects.toThrow(/private or local network/);
  });

  test("rejects 0.0.0.0", async () => {
    await expect(
      handleCreate({
        body: {
          name: "ssrf-zero",
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-ssrf" },
          base_url: "http://0.0.0.0:8080/v1",
          models: [{ id: "m" }],
        },
      }),
    ).rejects.toThrow(/private or local network/);
  });

  test("rejects 10.x.x.x", async () => {
    await expect(
      handleCreate({
        body: {
          name: "ssrf-ten",
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-ssrf" },
          base_url: "http://10.0.0.1/v1",
          models: [{ id: "m" }],
        },
      }),
    ).rejects.toThrow(/private or local network/);
  });

  test("rejects 127.0.0.1", async () => {
    await expect(
      handleCreate({
        body: {
          name: "ssrf-loopback",
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-ssrf" },
          base_url: "http://127.0.0.1:8080/v1",
          models: [{ id: "m" }],
        },
      }),
    ).rejects.toThrow(/private or local network/);
  });

  test("rejects metadata.google.internal", async () => {
    await expect(
      handleCreate({
        body: {
          name: "ssrf-metadata",
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-ssrf" },
          base_url: "http://metadata.google.internal/computeMetadata/v1/",
          models: [{ id: "m" }],
        },
      }),
    ).rejects.toThrow(/cloud metadata or link-local/);
  });

  test("rejects hostname that resolves to a private IP", async () => {
    mockResolvedAddresses = ["10.0.0.5"];
    await expect(
      handleCreate({
        body: {
          name: "ssrf-dns-rebind",
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-ssrf" },
          base_url: "https://dns-rebind.example.com/v1",
          models: [{ id: "m" }],
        },
      }),
    ).rejects.toThrow(/resolves to a private network/);
  });

  test("accepts a valid public URL", async () => {
    mockResolvedAddresses = ["93.184.216.34"];
    const result = await handleCreate({
      body: {
        name: "valid-public-url",
        provider: "openai-compatible",
        auth: { type: "api_key", credential: "cred-valid" },
        base_url: "https://api.example.com/v1",
        models: [{ id: "my-model" }],
      },
    });
    expect(result).toBeDefined();
    expect((result as { baseUrl: string }).baseUrl).toBe(
      "https://api.example.com/v1",
    );
  });
});

// ---------------------------------------------------------------------------
// Self-hosted vs platform: loopback/private base_url for openai-compatible
// ---------------------------------------------------------------------------

describe("base_url SSRF on self-hosted vs platform", () => {
  beforeEach(() => {
    // Self-hosted is the default; public DNS keeps non-literal hosts safe.
    mockIsPlatform = false;
    mockResolvedAddresses = ["93.184.216.34"];
  });

  const localUrls = [
    "http://localhost:1234/v1",
    "http://127.0.0.1:1234/v1",
    "http://192.168.1.10:1234/v1",
  ];

  for (const [i, url] of localUrls.entries()) {
    test(`self-hosted: accepts loopback/private base_url ${url}`, async () => {
      mockIsPlatform = false;
      const result = await handleCreate({
        body: {
          name: `self-hosted-local-${i}`,
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-local" },
          base_url: url,
          models: [{ id: "local-model" }],
        },
      });
      expect((result as { baseUrl: string }).baseUrl).toBe(url);
    });

    test(`platform-hosted: rejects loopback/private base_url ${url}`, async () => {
      mockIsPlatform = true;
      await expect(
        handleCreate({
          body: {
            name: `platform-local-${i}`,
            provider: "openai-compatible",
            auth: { type: "api_key", credential: "cred-local" },
            base_url: url,
            models: [{ id: "local-model" }],
          },
        }),
      ).rejects.toThrow(/private or local network/);
    });
  }

  test("self-hosted: rejects metadata.google.internal even though private is allowed", async () => {
    mockIsPlatform = false;
    await expect(
      handleCreate({
        body: {
          name: "self-hosted-metadata",
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-metadata" },
          base_url: "http://metadata.google.internal/computeMetadata/v1/",
          models: [{ id: "m" }],
        },
      }),
    ).rejects.toThrow(/cloud metadata or link-local/);
  });

  test("self-hosted: rejects 169.254.169.254 link-local metadata IP", async () => {
    mockIsPlatform = false;
    await expect(
      handleCreate({
        body: {
          name: "self-hosted-link-local",
          provider: "openai-compatible",
          auth: { type: "api_key", credential: "cred-link-local" },
          base_url: "http://169.254.169.254/latest/meta-data/",
          models: [{ id: "m" }],
        },
      }),
    ).rejects.toThrow(/cloud metadata or link-local/);
  });

  test("self-hosted: provider gate still rejects base_url on non-openai-compatible", async () => {
    mockIsPlatform = false;
    await expect(
      handleCreate({
        body: {
          name: "self-hosted-gate-anthropic",
          provider: "anthropic",
          auth: { type: "api_key", credential: "cred-gate" },
          base_url: "http://localhost:1234/v1",
        },
      }),
    ).rejects.toThrow(/base_url is only valid for openai-compatible/);
  });
});

// ---------------------------------------------------------------------------
// Update handler: base_url validation on existing connections
// ---------------------------------------------------------------------------

describe("base_url provider-type gate (update)", () => {
  test("rejects adding base_url to an existing anthropic connection", async () => {
    // Seed a connection first.
    await handleCreate({
      body: {
        name: "update-test-anthropic",
        provider: "anthropic",
        auth: { type: "api_key", credential: "cred-update" },
      },
    });

    await expect(
      handleUpdate({
        pathParams: { name: "update-test-anthropic" },
        body: {
          auth: { type: "api_key", credential: "cred-update" },
          base_url: "https://evil.example.com/v1",
        },
      }),
    ).rejects.toThrow(/base_url is only valid for openai-compatible/);
  });
});
