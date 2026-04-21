/**
 * Tests for the post-import vellum metadata reconciliation helper.
 *
 * After every bundle import, `reconcileVellumMetadataFromCes` walks the
 * four platform-identity fields the gateway requires and, for each one
 * that CES already holds a value for, ensures `metadata.json` lists a
 * matching entry. This closes the race where Django's post-hatch
 * provisioning writes its CES value successfully but its metadata upsert
 * gets clobbered by the import's in-place clear or atomic swap.
 *
 * We test the reconcile logic in isolation by mocking the secure-keys
 * and metadata-store modules — the real migration handler wires the
 * same imports, so the behavior under test matches production.
 *
 * Covered:
 * - CES has all 4 fields + metadata empty → all 4 upserted.
 * - CES has all 4 + metadata has 2 → only the missing 2 upserted.
 * - CES has no values → nothing upserted.
 * - CES has values + metadata already has them → no-op (no duplicate
 *   upserts).
 * - upsert throws for one field → warning recorded, loop continues.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../../../security/credential-key.js";

type MetadataRecord = {
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  createdAt: number;
  updatedAt: number;
};

const VELLUM_FIELDS = [
  "platform_base_url",
  "assistant_api_key",
  "platform_assistant_id",
  "webhook_secret",
] as const;

const upsertCalls: Array<{ service: string; field: string }> = [];
let metadataStore: Map<string, MetadataRecord> = new Map();
let cesValues: Map<string, string> = new Map();
let upsertImpl: (service: string, field: string) => void = (service, field) => {
  const key = `${service}:${field}`;
  metadataStore.set(key, {
    credentialId: `id-${key}`,
    service,
    field,
    allowedTools: [],
    allowedDomains: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
};

mock.module("../../../security/secure-keys.js", () => ({
  bulkSetSecureKeysAsync: async () => [],
  deleteSecureKeyAsync: async () => "ok",
  getActiveBackendName: () => "test",
  getMaskedProviderKey: async () => null,
  getProviderKeyAsync: async () => null,
  getSecureKeyAsync: async (key: string) => cesValues.get(key) ?? null,
  getSecureKeyResultAsync: async () => ({ ok: true, value: null }),
  listSecureKeysAsync: async () => [],
  onCesClientChanged: () => {},
  setCesClient: () => {},
  setCesReconnect: () => {},
  setSecureKeyAsync: async () => true,
  _resetBackend: () => {},
}));

mock.module("../../../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: (service: string, field: string) =>
    metadataStore.get(`${service}:${field}`),
  upsertCredentialMetadata: (
    service: string,
    field: string,
    _policy?: unknown,
  ) => {
    upsertCalls.push({ service, field });
    upsertImpl(service, field);
    return metadataStore.get(`${service}:${field}`);
  },
}));

// Import under test AFTER the mocks are set up.
const { reconcileVellumMetadataFromCes } =
  (await import("../migration-routes.js")) as unknown as {
    reconcileVellumMetadataFromCes: (sink: {
      warnings: string[];
    }) => Promise<void>;
  };

beforeEach(() => {
  upsertCalls.length = 0;
  metadataStore = new Map();
  cesValues = new Map();
  upsertImpl = (service, field) => {
    const key = `${service}:${field}`;
    metadataStore.set(key, {
      credentialId: `id-${key}`,
      service,
      field,
      allowedTools: [],
      allowedDomains: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };
});

afterEach(() => {
  upsertCalls.length = 0;
});

function seedAllFourInCes(): void {
  for (const field of VELLUM_FIELDS) {
    cesValues.set(credentialKey("vellum", field), `value-for-${field}`);
  }
}

describe("reconcileVellumMetadataFromCes", () => {
  test("CES holds all 4 fields, metadata empty → all 4 upserted", async () => {
    seedAllFourInCes();
    const sink = { warnings: [] as string[] };

    await reconcileVellumMetadataFromCes(sink);

    expect(upsertCalls).toHaveLength(4);
    expect(new Set(upsertCalls.map((c) => c.field))).toEqual(
      new Set(VELLUM_FIELDS),
    );
    expect(sink.warnings).toHaveLength(0);
  });

  test("CES holds all 4, metadata has 2 → only the missing 2 upserted", async () => {
    seedAllFourInCes();
    // Pre-populate metadata for 2 of the 4 fields.
    for (const field of ["platform_base_url", "assistant_api_key"] as const) {
      metadataStore.set(`vellum:${field}`, {
        credentialId: `id-vellum:${field}`,
        service: "vellum",
        field,
        allowedTools: [],
        allowedDomains: [],
        createdAt: 1,
        updatedAt: 1,
      });
    }

    const sink = { warnings: [] as string[] };
    await reconcileVellumMetadataFromCes(sink);

    expect(upsertCalls).toHaveLength(2);
    expect(new Set(upsertCalls.map((c) => c.field))).toEqual(
      new Set(["platform_assistant_id", "webhook_secret"]),
    );
  });

  test("CES empty → nothing upserted", async () => {
    const sink = { warnings: [] as string[] };
    await reconcileVellumMetadataFromCes(sink);
    expect(upsertCalls).toHaveLength(0);
    expect(sink.warnings).toHaveLength(0);
  });

  test("CES has values, metadata already has entries → no duplicate upserts", async () => {
    seedAllFourInCes();
    // Seed metadata for all 4.
    for (const field of VELLUM_FIELDS) {
      metadataStore.set(`vellum:${field}`, {
        credentialId: `id-vellum:${field}`,
        service: "vellum",
        field,
        allowedTools: [],
        allowedDomains: [],
        createdAt: 1,
        updatedAt: 1,
      });
    }

    const sink = { warnings: [] as string[] };
    await reconcileVellumMetadataFromCes(sink);

    expect(upsertCalls).toHaveLength(0);
  });

  test("upsert throws for one field → warning recorded, loop continues", async () => {
    seedAllFourInCes();
    let calls = 0;
    upsertImpl = (service, field) => {
      calls += 1;
      if (field === "assistant_api_key") {
        throw new Error("simulated metadata write failure");
      }
      const key = `${service}:${field}`;
      metadataStore.set(key, {
        credentialId: `id-${key}`,
        service,
        field,
        allowedTools: [],
        allowedDomains: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    };

    const sink = { warnings: [] as string[] };
    await reconcileVellumMetadataFromCes(sink);

    // Every field was attempted (loop did not abort).
    expect(calls).toBe(4);
    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toContain("vellum:assistant_api_key");
  });
});
