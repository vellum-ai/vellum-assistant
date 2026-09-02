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
import { eq } from "drizzle-orm";

import * as conversationStore from "../daemon/conversation-store.js";
import * as scrub from "../daemon/credential-transcript-scrub.js";
import * as manualToken from "../oauth/manual-token-connection.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { providerConnections } from "../persistence/schema/inference.js";
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
import { storeCredentialValue } from "../tools/credentials/store.js";

// Real metadata store backed by a temp file. A mock.module on metadata-store
// or secure-keys would replace the whole module namespace, so only the secure
// backend access, the transcript scrub, and the manual-token connection sync
// are intercepted, via restorable spies.

const TEST_DIR = join(
  tmpdir(),
  `vellum-plugin-storecred-${randomBytes(4).toString("hex")}`,
);
const META_PATH = join(TEST_DIR, "metadata.json");

/** The plugin every scoped case runs as: it owns the `acme` service. */
const PLUGIN = "acme";

/** Run `fn` as the plugin would: inside its execution context. */
function asPlugin<T>(fn: () => T): T {
  return runInPluginContext(PLUGIN, fn);
}

let secureStore: Map<string, string>;
let writeSucceeds: boolean;
let setSpy: ReturnType<typeof spyOn>;
let getSpy: ReturnType<typeof spyOn>;
let scrubSpy: ReturnType<typeof spyOn>;
let syncSpy: ReturnType<typeof spyOn>;
let evictSpy: ReturnType<typeof spyOn>;

await initializeDb();

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
  evictSpy = spyOn(
    conversationStore,
    "evictConversationsForReload",
  ).mockImplementation(() => {});
  getDb()
    .delete(providerConnections)
    .where(eq(providerConnections.name, "openrouter-connection"))
    .run();
});

afterEach(() => {
  setSpy.mockRestore();
  getSpy.mockRestore();
  scrubSpy.mockRestore();
  syncSpy.mockRestore();
  evictSpy.mockRestore();
});

afterAll(() => {
  _setMetadataPath(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("storeCredential", () => {
  test("creates a credential from a service/field ref", async () => {
    const stored = await asPlugin(() =>
      storeCredential("acme/api_key", "sk-secret"),
    );

    expect(stored.service).toBe("acme");
    expect(stored.field).toBe("api_key");
    expect(stored.credentialId).toBeTruthy();
    expect(secureStore.get(credentialKey("acme", "api_key"))).toBe("sk-secret");
    expect(getCredentialMetadata("acme", "api_key")?.credentialId).toBe(
      stored.credentialId,
    );
  });

  test("stores a value that resolveCredential reads back", async () => {
    await asPlugin(() => storeCredential("acme/api_key", "sk-secret"));
    await expect(
      asPlugin(() => resolveCredential("acme/api_key")),
    ).resolves.toBe("sk-secret");
  });

  test("trims edge whitespace from the value", async () => {
    await asPlugin(() => storeCredential("acme/api_key", "  sk-secret\n"));
    expect(secureStore.get(credentialKey("acme", "api_key"))).toBe("sk-secret");
  });

  test("records label and description on the credential metadata", async () => {
    await asPlugin(() =>
      storeCredential("acme/api_key", "sk-secret", {
        label: "Acme key",
        description: "Used by the acme plugin",
      }),
    );

    const metadata = getCredentialMetadata("acme", "api_key");
    expect(metadata?.alias).toBe("Acme key");
    expect(metadata?.usageDescription).toBe("Used by the acme plugin");
  });

  test("replaces the value of an existing credential named by UUID", async () => {
    const first = await asPlugin(() =>
      storeCredential("acme/api_key", "sk-old"),
    );
    const second = await asPlugin(() =>
      storeCredential(first.credentialId, "sk-new"),
    );

    expect(second).toEqual(first);
    expect(secureStore.get(credentialKey("acme", "api_key"))).toBe("sk-new");
  });

  test("rejects a ref that names no credential and is not service/field", async () => {
    await expect(
      asPlugin(() => storeCredential("openai", "sk-secret")),
    ).rejects.toBeInstanceOf(CredentialStoreError);
    expect(setSpy).not.toHaveBeenCalled();
  });

  test("rejects an empty value", async () => {
    await expect(
      asPlugin(() => storeCredential("acme/api_key", "   ")),
    ).rejects.toThrow(/value is required/);
    expect(setSpy).not.toHaveBeenCalled();
  });

  test("surfaces a failed secure-backend write", async () => {
    writeSucceeds = false;
    await expect(
      asPlugin(() => storeCredential("acme/api_key", "sk-secret")),
    ).rejects.toThrow(CredentialStoreError);
    expect(getCredentialMetadata("acme", "api_key")).toBeUndefined();
  });

  test("scrubs the stored value from recent transcripts", async () => {
    await asPlugin(() => storeCredential("acme/api_key", "sk-secret"));
    expect(scrubSpy).toHaveBeenCalledWith("sk-secret");
  });

  test("skips the transcript scrub when asked", async () => {
    await asPlugin(() =>
      storeCredential("acme/api_key", "sk-secret", {
        skipTranscriptScrub: true,
      }),
    );
    expect(scrubSpy).not.toHaveBeenCalled();
  });

  test("reconciles the manual-token connection for the service", async () => {
    await asPlugin(() => storeCredential("acme/api_key", "sk-secret"));
    expect(syncSpy).toHaveBeenCalledWith("acme");
  });

  /**
   * Verifies that storeCredentialValue refreshes providers for dependent connections.
   */
  test("refreshes providers when a stored credential backs a connection", async () => {
    // GIVEN a provider connection references the credential being stored.
    const now = Date.now();
    getDb()
      .insert(providerConnections)
      .values({
        name: "openrouter-connection",
        provider: "openai",
        auth: JSON.stringify({
          type: "api_key",
          credential: credentialKey("openrouter", "api_key"),
        }),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // AND the credential is non-managed.
    // WHEN the credential is stored.
    await storeCredentialValue({
      service: "openrouter",
      field: "api_key",
      value: "openrouter-key",
      skipTranscriptScrub: true,
    });

    // THEN the provider refresh runs once.
    expect(evictSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * Verifies that storeCredentialValue skips refresh for an unused credential.
   */
  test("does not refresh providers when a stored credential backs no connection", async () => {
    // GIVEN no provider connection references the credential being stored.
    // AND the credential is non-managed.
    // WHEN the credential is stored.
    await storeCredentialValue({
      service: "acme",
      field: "api_key",
      value: "acme-key",
      skipTranscriptScrub: true,
    });

    // THEN the provider refresh does not run.
    expect(evictSpy).toHaveBeenCalledTimes(0);
  });

  describe("plugin scoping", () => {
    test("fails closed with no plugin in context", async () => {
      // A plugin's module body is evaluated outside any context. An unscoped
      // branch there would let top-level code overwrite the user's own
      // credentials, so the write is refused instead.
      await expect(
        storeCredential("acme/api_key", "sk-secret"),
      ).rejects.toThrow(/requires an active plugin execution context/);
      expect(setSpy).not.toHaveBeenCalled();
      expect(getCredentialMetadata("acme", "api_key")).toBeUndefined();
    });

    test("blocks a plugin from storing a credential it does not own", async () => {
      await expect(
        asPlugin(() => storeCredential("openai/api_key", "sk-secret")),
      ).rejects.toThrow(/out of scope/);
    });

    test("does not write the secure backend when out of scope", async () => {
      await expect(
        asPlugin(() => storeCredential("openai/api_key", "sk-secret")),
      ).rejects.toThrow(CredentialStoreError);
      expect(setSpy).not.toHaveBeenCalled();
      expect(getCredentialMetadata("openai", "api_key")).toBeUndefined();
    });

    test("blocks a plugin from overwriting another credential by UUID", async () => {
      // Seeded through the host write path, the way the user's own credential
      // is created (`credentials set`), not through the plugin API.
      const existing = await storeCredentialValue({
        service: "openai",
        field: "api_key",
        value: "sk-user",
        skipTranscriptScrub: true,
      });
      setSpy.mockClear();

      await expect(
        asPlugin(() => storeCredential(existing.credentialId, "sk-hijacked")),
      ).rejects.toThrow(/out of scope/);
      expect(setSpy).not.toHaveBeenCalled();
      expect(secureStore.get(credentialKey("openai", "api_key"))).toBe(
        "sk-user",
      );
    });

    test("blocks a plugin from storing another service even when the field matches its name", async () => {
      await expect(
        asPlugin(() => storeCredential("openai/acme", "sk-secret")),
      ).rejects.toThrow(/out of scope/);
      expect(setSpy).not.toHaveBeenCalled();
    });

    test("allows a plugin to store multiple fields under its own service", async () => {
      await asPlugin(async () => {
        await storeCredential("acme/api_key", "key-secret");
        await storeCredential("acme/token", "token-secret");
      });

      expect(secureStore.get(credentialKey("acme", "api_key"))).toBe(
        "key-secret",
      );
      expect(secureStore.get(credentialKey("acme", "token"))).toBe(
        "token-secret",
      );
    });
  });
});
