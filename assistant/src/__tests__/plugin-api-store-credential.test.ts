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

import * as scrub from "../daemon/credential-transcript-scrub.js";
import * as manualToken from "../oauth/manual-token-connection.js";
import { resolveCredential } from "../plugin-api/resolve-credential.js";
import {
  CredentialStoreError,
  storeCredential,
} from "../plugin-api/store-credential.js";
import { runInPluginContext } from "../plugins/plugin-execution-context.js";
import * as secureKeys from "../security/secure-keys.js";
import {
  _setMetadataPath,
  getCredentialMetadata,
} from "../tools/credentials/metadata-store.js";

// Real metadata store backed by a temp file (no module mocking — a mock.module
// on metadata-store / secure-keys would replace the whole module namespace and
// leak into other test files in the same process). Only the secure backend
// access, the transcript scrub, and the manual-token connection sync are
// intercepted, via restorable spies.

const TEST_DIR = join(
  tmpdir(),
  `vellum-plugin-storecred-${randomBytes(4).toString("hex")}`,
);
const META_PATH = join(TEST_DIR, "metadata.json");

let secureStore: Map<string, string>;
let writeSucceeds: boolean;
let setSpy: ReturnType<typeof spyOn>;
let getSpy: ReturnType<typeof spyOn>;
let scrubSpy: ReturnType<typeof spyOn>;
let syncSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  _setMetadataPath(META_PATH);

  secureStore = new Map();
  writeSucceeds = true;
  setSpy = spyOn(secureKeys, "setSecureKeyAsync").mockImplementation(
    async (key: string, value: string) => {
      if (!writeSucceeds) {
        return false;
      }
      secureStore.set(key, value);
      return true;
    },
  );
  getSpy = spyOn(secureKeys, "getSecureKeyResultAsync").mockImplementation(
    async (key: string) => ({
      value: secureStore.get(key),
      unreachable: false,
    }),
  );
  scrubSpy = spyOn(
    scrub,
    "scrubStoredCredentialFromTranscripts",
  ).mockImplementation(async () => ({
    dbMessagesScrubbed: 0,
    residentMessagesScrubbed: 0,
  }));
  syncSpy = spyOn(manualToken, "syncManualTokenConnection").mockImplementation(
    async () => {},
  );
});

afterEach(() => {
  setSpy.mockRestore();
  getSpy.mockRestore();
  scrubSpy.mockRestore();
  syncSpy.mockRestore();
});

afterAll(() => {
  _setMetadataPath(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("storeCredential", () => {
  test("creates a credential from a service/field ref", async () => {
    const stored = await storeCredential("openai/acme", "sk-secret");

    expect(stored.service).toBe("openai");
    expect(stored.field).toBe("acme");
    expect(stored.credentialId).toBeTruthy();
    expect(secureStore.get(credentialKey("openai", "acme"))).toBe("sk-secret");
    expect(getCredentialMetadata("openai", "acme")?.credentialId).toBe(
      stored.credentialId,
    );
  });

  test("stores a value that resolveCredential reads back", async () => {
    await storeCredential("openai/acme", "sk-secret");
    await expect(resolveCredential("openai/acme")).resolves.toBe("sk-secret");
  });

  test("trims edge whitespace from the value", async () => {
    await storeCredential("openai/acme", "  sk-secret\n");
    expect(secureStore.get(credentialKey("openai", "acme"))).toBe("sk-secret");
  });

  test("records label and description on the credential metadata", async () => {
    await storeCredential("openai/acme", "sk-secret", {
      label: "Acme key",
      description: "Used by the acme plugin",
    });

    const metadata = getCredentialMetadata("openai", "acme");
    expect(metadata?.alias).toBe("Acme key");
    expect(metadata?.usageDescription).toBe("Used by the acme plugin");
  });

  test("replaces the value of an existing credential named by UUID", async () => {
    const first = await storeCredential("openai/acme", "sk-old");
    const second = await storeCredential(first.credentialId, "sk-new");

    expect(second).toEqual(first);
    expect(secureStore.get(credentialKey("openai", "acme"))).toBe("sk-new");
  });

  test("rejects a ref that names no credential and is not service/field", async () => {
    await expect(storeCredential("openai", "sk-secret")).rejects.toBeInstanceOf(
      CredentialStoreError,
    );
    expect(setSpy).not.toHaveBeenCalled();
  });

  test("rejects an empty value", async () => {
    await expect(storeCredential("openai/acme", "   ")).rejects.toThrow(
      /value is required/,
    );
    expect(setSpy).not.toHaveBeenCalled();
  });

  test("surfaces a failed secure-backend write", async () => {
    writeSucceeds = false;
    await expect(storeCredential("openai/acme", "sk-secret")).rejects.toThrow(
      CredentialStoreError,
    );
    expect(getCredentialMetadata("openai", "acme")).toBeUndefined();
  });

  test("scrubs the stored value from recent transcripts", async () => {
    await storeCredential("openai/acme", "sk-secret");
    expect(scrubSpy).toHaveBeenCalledWith("sk-secret");
  });

  test("skips the transcript scrub when asked", async () => {
    await storeCredential("openai/acme", "sk-secret", {
      skipTranscriptScrub: true,
    });
    expect(scrubSpy).not.toHaveBeenCalled();
  });

  test("reconciles the manual-token connection for the service", async () => {
    await storeCredential("openai/acme", "sk-secret");
    expect(syncSpy).toHaveBeenCalledWith("openai");
  });

  describe("plugin scoping", () => {
    test("allows a plugin to store a credential whose field matches its name", async () => {
      const stored = await runInPluginContext("acme", () =>
        storeCredential("openai/acme", "scoped-secret"),
      );
      expect(stored.field).toBe("acme");
      expect(secureStore.get(credentialKey("openai", "acme"))).toBe(
        "scoped-secret",
      );
    });

    test("blocks a plugin from storing a credential whose field differs from its name", async () => {
      await expect(
        runInPluginContext("acme", () =>
          storeCredential("openai/api_key", "sk-secret"),
        ),
      ).rejects.toThrow(/out of scope/);
    });

    test("does not write the secure backend when out of scope", async () => {
      await expect(
        runInPluginContext("acme", () =>
          storeCredential("openai/api_key", "sk-secret"),
        ),
      ).rejects.toThrow(CredentialStoreError);
      expect(setSpy).not.toHaveBeenCalled();
      expect(getCredentialMetadata("openai", "api_key")).toBeUndefined();
    });

    test("blocks a plugin from overwriting another credential by UUID", async () => {
      const existing = await storeCredential("openai/api_key", "sk-user");
      setSpy.mockClear();

      await expect(
        runInPluginContext("acme", () =>
          storeCredential(existing.credentialId, "sk-hijacked"),
        ),
      ).rejects.toThrow(/out of scope/);
      expect(setSpy).not.toHaveBeenCalled();
      expect(secureStore.get(credentialKey("openai", "api_key"))).toBe(
        "sk-user",
      );
    });

    test("scoping applies by field only, across any service", async () => {
      await runInPluginContext("acme", async () => {
        await storeCredential("stripe/acme", "stripe-secret");
        await storeCredential("openai/acme", "openai-secret");
      });

      expect(secureStore.get(credentialKey("stripe", "acme"))).toBe(
        "stripe-secret",
      );
      expect(secureStore.get(credentialKey("openai", "acme"))).toBe(
        "openai-secret",
      );
    });
  });
});
