import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let secureStore: Map<string, string>;
let unreachable: boolean;

mock.module("../security/credential-key.js", () => ({
  credentialKey: (service: string, field: string) => `${service}:${field}`,
}));

mock.module("@vellumai/credential-storage", () => ({
  credentialKey: (service: string, field: string) => `${service}:${field}`,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: mock(async (key: string) => ({
    value: secureStore.get(key),
    unreachable: unreachable && !secureStore.has(key),
  })),
}));

interface FakeMeta {
  credentialId: string;
  service: string;
  field: string;
  injectionTemplates?: unknown[];
}

let metadataStore: Map<string, FakeMeta>;
const metaKey = (service: string, field: string) => `${service}:${field}`;

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: (service: string, field: string) =>
    metadataStore.get(metaKey(service, field)),
  getCredentialMetadataById: (id: string) =>
    Array.from(metadataStore.values()).find((m) => m.credentialId === id),
  listCredentialMetadata: () => Array.from(metadataStore.values()),
}));

// Imported AFTER mocks are registered.
const { resolveCredential, CredentialResolutionError } =
  await import("../plugin-api/resolve-credential.js");
const { runInPluginContext } =
  await import("../plugins/plugin-execution-context.js");

function seedCredential(service: string, field: string, value: string): void {
  metadataStore.set(metaKey(service, field), {
    credentialId: `id-${service}-${field}`,
    service,
    field,
    injectionTemplates: [],
  });
  secureStore.set(`${service}:${field}`, value);
}

beforeEach(() => {
  secureStore = new Map();
  metadataStore = new Map();
  unreachable = false;
});

describe("resolveCredential", () => {
  test("resolves plaintext by service/field ref when no plugin is in context", async () => {
    seedCredential("openai", "api_key", "sk-secret");
    await expect(resolveCredential("openai/api_key")).resolves.toBe(
      "sk-secret",
    );
  });

  test("resolves plaintext by credential UUID", async () => {
    seedCredential("stripe", "acme", "stripe-secret");
    await expect(resolveCredential("id-stripe-acme")).resolves.toBe(
      "stripe-secret",
    );
  });

  test("throws not found for an unknown ref", async () => {
    await expect(resolveCredential("nope/missing")).rejects.toBeInstanceOf(
      CredentialResolutionError,
    );
  });

  test("throws when the store is unreachable", async () => {
    metadataStore.set(metaKey("openai", "api_key"), {
      credentialId: "id-openai-api_key",
      service: "openai",
      field: "api_key",
      injectionTemplates: [],
    });
    unreachable = true;
    await expect(resolveCredential("openai/api_key")).rejects.toThrow(
      /unreachable/,
    );
  });

  describe("plugin scoping", () => {
    test("allows a plugin to resolve a credential whose field matches its name", async () => {
      seedCredential("openai", "acme", "scoped-secret");
      const value = await runInPluginContext("acme", () =>
        resolveCredential("openai/acme"),
      );
      expect(value).toBe("scoped-secret");
    });

    test("blocks a plugin from resolving a credential whose field differs from its name", async () => {
      seedCredential("openai", "api_key", "sk-secret");
      await expect(
        runInPluginContext("acme", () => resolveCredential("openai/api_key")),
      ).rejects.toThrow(/out of scope/);
    });

    test("does not read the secure backend when out of scope", async () => {
      seedCredential("openai", "api_key", "sk-secret");
      const secureKeys = await import("../security/secure-keys.js");
      const spy = secureKeys.getSecureKeyResultAsync as ReturnType<typeof mock>;
      spy.mockClear();
      await expect(
        runInPluginContext("acme", () => resolveCredential("openai/api_key")),
      ).rejects.toThrow(CredentialResolutionError);
      expect(spy).not.toHaveBeenCalled();
    });

    test("scoping applies by field only, across any service", async () => {
      seedCredential("stripe", "acme", "stripe-secret");
      seedCredential("openai", "acme", "openai-secret");
      await expect(
        runInPluginContext("acme", () => resolveCredential("stripe/acme")),
      ).resolves.toBe("stripe-secret");
      await expect(
        runInPluginContext("acme", () => resolveCredential("openai/acme")),
      ).resolves.toBe("openai-secret");
    });
  });
});
