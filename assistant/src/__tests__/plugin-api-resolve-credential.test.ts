import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";

import {
  CredentialResolutionError,
  resolveCredential,
} from "../plugin-api/resolve-credential.js";
import { runInPluginContext } from "../plugins/plugin-execution-context.js";
import * as secureKeys from "../security/secure-keys.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";

// Real metadata store backed by a temp file (no module mocking — a mock.module
// on metadata-store / secure-keys would replace the whole module namespace and
// leak into other test files in the same process). Only the secure backend read
// is intercepted, via a restorable spy.

const TEST_DIR = join(
  tmpdir(),
  `vellum-plugin-resolvecred-${randomBytes(4).toString("hex")}`,
);
const META_PATH = join(TEST_DIR, "metadata.json");

let secureStore: Map<string, string>;
let unreachable: boolean;
let getSpy: ReturnType<typeof spyOn>;

function seedCredential(service: string, field: string, value: string): string {
  const meta = upsertCredentialMetadata(service, field, {});
  secureStore.set(credentialKey(service, field), value);
  return meta.credentialId;
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  _setMetadataPath(META_PATH);

  secureStore = new Map();
  unreachable = false;
  getSpy = spyOn(secureKeys, "getSecureKeyResultAsync").mockImplementation(
    async (key: string) => ({
      value: secureStore.get(key),
      unreachable: unreachable && !secureStore.has(key),
    }),
  );
});

afterEach(() => {
  getSpy.mockRestore();
});

afterAll(() => {
  _setMetadataPath(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("resolveCredential", () => {
  test("resolves plaintext by service/field ref when no plugin is in context", async () => {
    seedCredential("openai", "api_key", "sk-secret");
    await expect(resolveCredential("openai/api_key")).resolves.toBe(
      "sk-secret",
    );
  });

  test("resolves plaintext by credential UUID", async () => {
    const id = seedCredential("stripe", "acme", "stripe-secret");
    await expect(resolveCredential(id)).resolves.toBe("stripe-secret");
  });

  test("throws not found for an unknown ref", async () => {
    await expect(resolveCredential("nope/missing")).rejects.toBeInstanceOf(
      CredentialResolutionError,
    );
  });

  test("throws when the store is unreachable", async () => {
    upsertCredentialMetadata("openai", "api_key", {});
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
      getSpy.mockClear();
      await expect(
        runInPluginContext("acme", () => resolveCredential("openai/api_key")),
      ).rejects.toThrow(CredentialResolutionError);
      expect(getSpy).not.toHaveBeenCalled();
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
