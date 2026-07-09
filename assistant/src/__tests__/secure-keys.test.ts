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
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger (no-op — compatible with other test files' identical mock)
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { CesClient } from "../credential-execution/client.js";
import * as encryptedStore from "../security/encrypted-store.js";
import {
  _resetBackend,
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  getSecureKeyResultAsync,
  listSecureKeysAsync,
  setCesClient,
  setCesReconnect,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

// ---------------------------------------------------------------------------
// Use a temp directory for encrypted store tests
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `vellum-seckeys-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

describe("secure-keys", () => {
  beforeEach(() => {
    _resetBackend();

    // Ensure VELLUM_DEV and VELLUM_DESKTOP_APP are NOT set
    delete process.env.VELLUM_DEV;
    delete process.env.VELLUM_DESKTOP_APP;

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    setStorePathForTesting(STORE_PATH);
  });

  afterEach(() => {
    setStorePathForTesting(null);
    _resetBackend();
    delete process.env.VELLUM_DEV;
    delete process.env.VELLUM_DESKTOP_APP;
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // -----------------------------------------------------------------------
  // CRUD operations (encrypted store backend)
  // -----------------------------------------------------------------------
  describe("CRUD with encrypted backend", () => {
    test("set and get a key", async () => {
      await setSecureKeyAsync("openai", "sk-openai-789");
      expect(await getSecureKeyAsync("openai")).toBe("sk-openai-789");
    });

    test("get returns undefined for nonexistent key", async () => {
      expect(await getSecureKeyAsync("nonexistent")).toBeUndefined();
    });

    test("delete removes a key", async () => {
      await setSecureKeyAsync("gemini", "gem-key");
      expect(await deleteSecureKeyAsync("gemini")).toBe("deleted");
      expect(await getSecureKeyAsync("gemini")).toBeUndefined();
    });

    test("delete returns not-found for nonexistent key", async () => {
      expect(await deleteSecureKeyAsync("missing")).toBe("not-found");
    });
  });

  // -----------------------------------------------------------------------
  // Desktop app uses encrypted store (same as dev/CLI)
  // -----------------------------------------------------------------------
  describe("desktop app uses encrypted store", () => {
    test("VELLUM_DESKTOP_APP=1 writes to encrypted store", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      expect(encryptedStore.getKey("api-key")).toBe("new-value");
    });

    test("VELLUM_DESKTOP_APP=1 reads from encrypted store", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await getSecureKeyAsync("api-key");
      expect(result).toBe("encrypted-value");
    });

    test("VELLUM_DESKTOP_APP=1 deletes from encrypted store", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Dev mode — VELLUM_DEV=1 uses encrypted store
  // -----------------------------------------------------------------------
  describe("dev mode (VELLUM_DEV=1)", () => {
    test("setSecureKeyAsync writes to encrypted store", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "dev-value");
      expect(result).toBe(true);
      expect(encryptedStore.getKey("api-key")).toBe("dev-value");
    });

    test("getSecureKeyAsync reads from encrypted store", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await getSecureKeyAsync("api-key");
      expect(result).toBe("encrypted-value");
    });

    test("getSecureKeyAsync returns undefined when encrypted store is empty", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      const result = await getSecureKeyAsync("api-key");
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Non-desktop topology uses encrypted store
  // -----------------------------------------------------------------------
  describe("non-desktop topology", () => {
    test("uses encrypted store", async () => {
      _resetBackend();

      const result = await setSecureKeyAsync("api-key", "new-value");
      expect(result).toBe(true);
      expect(encryptedStore.getKey("api-key")).toBe("new-value");
    });
  });

  // -----------------------------------------------------------------------
  // Delete — single backend
  // -----------------------------------------------------------------------
  describe("delete from encrypted store", () => {
    test("deleteSecureKeyAsync removes key from encrypted store", async () => {
      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync in dev mode deletes from encrypted store", async () => {
      process.env.VELLUM_DEV = "1";
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      encryptedStore.setKey("api-key", "encrypted-value");

      const result = await deleteSecureKeyAsync("api-key");
      expect(result).toBe("deleted");
      expect(encryptedStore.getKey("api-key")).toBeUndefined();
    });

    test("deleteSecureKeyAsync returns not-found when key missing", async () => {
      const result = await deleteSecureKeyAsync("missing-key");
      expect(result).toBe("not-found");
    });
  });

  // -----------------------------------------------------------------------
  // listSecureKeysAsync — single-backend key listing
  // -----------------------------------------------------------------------
  describe("listSecureKeysAsync", () => {
    test("returns encrypted store keys", async () => {
      encryptedStore.setKey("enc-key-1", "val1");
      encryptedStore.setKey("enc-key-2", "val2");

      const result = await listSecureKeysAsync();
      expect(result.unreachable).toBe(false);
      expect(result.accounts).toContain("enc-key-1");
      expect(result.accounts).toContain("enc-key-2");
      expect(result.accounts.length).toBe(2);
    });

    test("returns encrypted store keys with VELLUM_DEV=1", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      encryptedStore.setKey("dev-key-1", "val2");
      encryptedStore.setKey("dev-key-2", "val3");

      const result = await listSecureKeysAsync();
      expect(result.unreachable).toBe(false);
      expect(result.accounts).toContain("dev-key-1");
      expect(result.accounts).toContain("dev-key-2");
      expect(result.accounts.length).toBe(2);
    });

    test("returns encrypted store keys with VELLUM_DESKTOP_APP=1", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      encryptedStore.setKey("desktop-key-1", "val1");
      encryptedStore.setKey("desktop-key-2", "val2");

      const result = await listSecureKeysAsync();
      expect(result.unreachable).toBe(false);
      expect(result.accounts).toContain("desktop-key-1");
      expect(result.accounts).toContain("desktop-key-2");
      expect(result.accounts.length).toBe(2);
    });

    test("returns empty accounts when store is empty", async () => {
      const result = await listSecureKeysAsync();
      expect(result).toEqual({ accounts: [], unreachable: false });
    });
  });

  // -----------------------------------------------------------------------
  // getSecureKeyResultAsync — richer result with unreachable flag
  // -----------------------------------------------------------------------
  describe("getSecureKeyResultAsync", () => {
    test("returns value and unreachable false on success", async () => {
      encryptedStore.setKey("api-key", "stored-value");

      const result = await getSecureKeyResultAsync("api-key");
      expect(result.value).toBe("stored-value");
      expect(result.unreachable).toBe(false);
    });

    test("returns unreachable false when key missing (encrypted store always reachable)", async () => {
      const result = await getSecureKeyResultAsync("missing-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(false);
    });

    test("returns unreachable false in dev mode", async () => {
      process.env.VELLUM_DEV = "1";
      _resetBackend();

      const result = await getSecureKeyResultAsync("missing-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(false);
    });

    test("returns unreachable false with VELLUM_DESKTOP_APP=1", async () => {
      process.env.VELLUM_DESKTOP_APP = "1";
      _resetBackend();

      const result = await getSecureKeyResultAsync("missing-key");
      expect(result.value).toBeUndefined();
      expect(result.unreachable).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Mock CES client — shared by the reconnection test suites below
  // -----------------------------------------------------------------------

  interface MockCesClient extends CesClient {
    setReady: (ready: boolean) => void;
    /** Credential writes received via `call`, in order. */
    sets: Array<{ account: string; value: string }>;
  }

  function makeMockCesClient(initialReady = true): MockCesClient {
    let ready = initialReady;
    const sets: Array<{ account: string; value: string }> = [];
    return {
      handshake: async () => ({ accepted: true }),
      call: async (_method: unknown, params: unknown) => {
        const p = params as { account?: string; value?: string };
        if (typeof p?.account === "string" && typeof p?.value === "string") {
          sets.push({ account: p.account, value: p.value });
        }
        return { ok: true, found: false, value: undefined } as never;
      },
      isReady: () => ready,
      close: () => {
        ready = false;
      },
      updateAssistantApiKey: async () => ({ updated: true }),
      setReady: (r: boolean) => {
        ready = r;
      },
      sets,
    } as MockCesClient;
  }

  // -----------------------------------------------------------------------
  // CES reconnection reentrancy
  // -----------------------------------------------------------------------
  //
  // The reconnect callback runs while the credential resolver is waiting on
  // `_reconnectInFlight`. A nested `getSecureKeyAsync()` from inside the
  // callback — e.g. `resolveManagedProxyContext()` reading the assistant API
  // key for the handshake — would recursively `await` the same in-flight
  // promise and deadlock for 45 seconds until `CREDENTIAL_OP_TIMEOUT_MS`
  // fires. The guard in `attemptCesReconnection` short-circuits that
  // reentrant case so nested reads resolve immediately (as "unreachable")
  // and the outer reconnect makes progress.
  describe("reconnect callback reentrancy", () => {
    test("nested credential read inside reconnect callback does not deadlock", async () => {
      // Seed the encrypted store with a value so nested reads have something
      // to target if they were to accidentally succeed via fallback paths.
      encryptedStore.setKey("test-key", "encrypted-value");

      // Install a CES client that starts ready so the first read resolves
      // the backend to CES RPC, then flip it to unready so the NEXT read
      // triggers the reconnect path.
      const client = makeMockCesClient(true);
      setCesClient(client);

      // Prime the resolver so `_resolvedBackend` points at CES RPC.
      await getSecureKeyAsync("test-key");
      client.setReady(false);

      let nestedReadResolved = false;
      let reconnectCallbackRan = 0;

      setCesReconnect(async () => {
        reconnectCallbackRan++;
        // Yield once so `_reconnectInFlight` (assigned after this IIFE's
        // first await) is observable to any nested resolver. This matches
        // production timing, where the callback awaits `pm.stop()` /
        // `pm.start()` before reading credentials — those awaits complete
        // the outer assignment, so the subsequent nested read sees a live
        // `_reconnectInFlight` and is the recursion that caused the 45s
        // deadlock.
        await Promise.resolve();
        await getSecureKeyAsync("test-key");
        nestedReadResolved = true;
        return makeMockCesClient(true);
      });

      const start = Date.now();
      await getSecureKeyAsync("test-key");
      const elapsed = Date.now() - start;

      expect(reconnectCallbackRan).toBe(1);
      expect(nestedReadResolved).toBe(true);
      // Pre-fix, this took 45s (CREDENTIAL_OP_TIMEOUT_MS). Post-fix it's
      // bounded only by the mock callback's own work.
      expect(elapsed).toBeLessThan(2000);
    });

    test("reconnect callback that throws still releases the reentrancy flag", async () => {
      const client = makeMockCesClient(true);
      setCesClient(client);
      await getSecureKeyAsync("any-key"); // prime the resolver
      client.setReady(false);

      setCesReconnect(async () => {
        throw new Error("boom");
      });

      await getSecureKeyAsync("any-key");

      // Swap in a reconnect that succeeds and wait past the 3s cooldown
      // in `attemptCesReconnection`. A stuck reentrancy flag from the
      // throwing callback would prevent this second attempt from running.
      let secondCallbackRan = 0;
      setCesReconnect(async () => {
        secondCallbackRan++;
        return makeMockCesClient(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 3_100));

      await getSecureKeyAsync("any-key");
      expect(secondCallbackRan).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Write ops bypass the reconnect cooldown
  // -----------------------------------------------------------------------
  //
  // Credential writes are rare and have no fallback: a set that fails
  // because a reconnect completed moments earlier is silently dropped by
  // callers (e.g. the post-login platform credential push stores the
  // assistant API key exactly once). Writes therefore force a reconnection
  // attempt even inside the cooldown window, while reads keep respecting
  // the cooldown to avoid restart stampedes.
  describe("write ops bypass the reconnect cooldown", () => {
    /**
     * Resolve the backend to a CES client, kill it, and burn one
     * reconnection attempt (which fails) so the cooldown window is active.
     * Returns the number of reconnect callback runs via a counter ref.
     */
    async function enterCooldownWithDeadBackend(): Promise<{
      counter: { runs: number };
      setReconnectResult: (client: CesClient | undefined) => void;
    }> {
      const client = makeMockCesClient(true);
      setCesClient(client);
      await getSecureKeyAsync("prime-key");
      client.setReady(false);

      const counter = { runs: 0 };
      let reconnectResult: CesClient | undefined;
      setCesReconnect(async () => {
        counter.runs++;
        return reconnectResult;
      });

      // Trigger one failed reconnection attempt to stamp the cooldown.
      await getSecureKeyAsync("prime-key");

      return {
        counter,
        setReconnectResult: (c) => {
          reconnectResult = c;
        },
      };
    }

    test("set during the cooldown reconnects and stores on the fresh client", async () => {
      const { counter, setReconnectResult } =
        await enterCooldownWithDeadBackend();
      expect(counter.runs).toBe(1);

      const fresh = makeMockCesClient(true);
      setReconnectResult(fresh);

      const ok = await setSecureKeyAsync("credential/vellum/api_key", "sk-1");

      expect(ok).toBe(true);
      expect(counter.runs).toBe(2);
      expect(fresh.sets).toEqual([
        { account: "credential/vellum/api_key", value: "sk-1" },
      ]);
    });

    test("read during the cooldown does not trigger another reconnect", async () => {
      const { counter, setReconnectResult } =
        await enterCooldownWithDeadBackend();
      expect(counter.runs).toBe(1);

      setReconnectResult(makeMockCesClient(true));

      const result = await getSecureKeyResultAsync("prime-key");

      expect(counter.runs).toBe(1);
      expect(result.unreachable).toBe(true);
    });

    test("set during the cooldown upgrades from the encrypted-store fallback to CES", async () => {
      // No CES client installed — the resolver lands on the encrypted store,
      // the fallback used when CES fails at startup.
      await getSecureKeyAsync("prime-key");

      const fresh = makeMockCesClient(true);
      const counter = { runs: 0 };
      setCesReconnect(async () => {
        counter.runs++;
        // First attempt fails; later attempts hand back a live CES client.
        return counter.runs === 1 ? undefined : fresh;
      });

      // A read attempts the CES upgrade (and fails), stamping the cooldown.
      await getSecureKeyAsync("prime-key");
      expect(counter.runs).toBe(1);

      const ok = await setSecureKeyAsync("credential/vellum/api_key", "sk-2");

      expect(ok).toBe(true);
      expect(counter.runs).toBe(2);
      expect(fresh.sets).toEqual([
        { account: "credential/vellum/api_key", value: "sk-2" },
      ]);
      // The write went to CES, not the local fallback store.
      expect(
        encryptedStore.getKey("credential/vellum/api_key"),
      ).toBeUndefined();
    });
  });
});
