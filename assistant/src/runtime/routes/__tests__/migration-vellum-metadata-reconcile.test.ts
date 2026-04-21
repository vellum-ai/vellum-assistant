/**
 * Tests for the post-import vellum metadata reconciliation helper.
 *
 * After every bundle import, `reconcileVellumMetadataFromCes` walks the
 * platform-identity fields the gateway requires and, for each one that
 * CES already holds a value for, ensures `metadata.json` lists a
 * matching entry. This closes the race where a provisioning write to
 * CES completes successfully but its metadata upsert gets clobbered by
 * the import's in-place clear or atomic swap. The reconciled set covers
 * both the Django-provisioned fields (assistant_api_key,
 * platform_assistant_id, platform_base_url, webhook_secret) and the
 * client-injected identity fields (platform_organization_id,
 * platform_user_id).
 *
 * We test the reconcile logic in isolation by mocking the secure-keys
 * and metadata-store modules — the real migration handler wires the
 * same imports, so the behavior under test matches production.
 *
 * Covered:
 * - CES has all 6 fields + metadata empty → all 6 upserted.
 * - CES has all 6 + metadata has 2 → only the missing 4 upserted.
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
  "platform_organization_id",
  "platform_user_id",
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

function seedAllInCes(): void {
  for (const field of VELLUM_FIELDS) {
    cesValues.set(credentialKey("vellum", field), `value-for-${field}`);
  }
}

describe("reconcileVellumMetadataFromCes", () => {
  test("CES holds all fields, metadata empty → all upserted", async () => {
    seedAllInCes();
    const sink = { warnings: [] as string[] };

    await reconcileVellumMetadataFromCes(sink);

    expect(upsertCalls).toHaveLength(VELLUM_FIELDS.length);
    expect(new Set(upsertCalls.map((c) => c.field))).toEqual(
      new Set(VELLUM_FIELDS),
    );
    expect(sink.warnings).toHaveLength(0);
  });

  test("CES holds all, metadata has 2 → only the missing ones upserted", async () => {
    seedAllInCes();
    // Pre-populate metadata for 2 of the fields.
    const prepopulated = ["platform_base_url", "assistant_api_key"] as const;
    for (const field of prepopulated) {
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

    const expectedMissing = VELLUM_FIELDS.filter(
      (f) => !(prepopulated as readonly string[]).includes(f),
    );
    expect(upsertCalls).toHaveLength(expectedMissing.length);
    expect(new Set(upsertCalls.map((c) => c.field))).toEqual(
      new Set(expectedMissing),
    );
  });

  test("covers both Django-provisioned and client-injected identity fields", async () => {
    seedAllInCes();
    const sink = { warnings: [] as string[] };
    await reconcileVellumMetadataFromCes(sink);

    const reconciled = new Set(upsertCalls.map((c) => c.field));
    // Django-provisioned quartet.
    expect(reconciled).toContain("platform_base_url");
    expect(reconciled).toContain("assistant_api_key");
    expect(reconciled).toContain("platform_assistant_id");
    expect(reconciled).toContain("webhook_secret");
    // Client-injected identity fields (onboarding / teleport / transfer).
    expect(reconciled).toContain("platform_organization_id");
    expect(reconciled).toContain("platform_user_id");
  });

  test("CES empty → nothing upserted", async () => {
    const sink = { warnings: [] as string[] };
    await reconcileVellumMetadataFromCes(sink);
    expect(upsertCalls).toHaveLength(0);
    expect(sink.warnings).toHaveLength(0);
  });

  test("CES has values, metadata already has entries → no duplicate upserts", async () => {
    seedAllInCes();
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
    seedAllInCes();
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
    expect(calls).toBe(VELLUM_FIELDS.length);
    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toContain("vellum:assistant_api_key");
  });
});
