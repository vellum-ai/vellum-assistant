/**
 * Diagnostic tests that run WITHOUT mocks to verify which secure-key
 * backend is actually used in the current environment (CI or local).
 *
 * These tests answer three questions:
 *   1. Is setSecureKey using the keychain broker or the encrypted file store?
 *   2. If the broker were available, would it work?
 *   3. Why is the broker unavailable (when it is)?
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { hostname, platform, userInfo } from "node:os";
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
// Mock logger only — everything else uses real implementations
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { _setStorePath } from "../security/encrypted-store.js";
import { createBrokerClient } from "../security/keychain-broker-client.js";
import {
  _resetBackend,
  getBackendType,
  getSecureKey,
  getSecureKeyAsync,
  setSecureKey,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { getRootDir } from "../util/platform.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-ci-backend-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

/** True when the broker socket + token exist (e.g. developer machine with app running). */
function isBrokerPresent(): boolean {
  const rootDir = getRootDir();
  return (
    existsSync(join(rootDir, "keychain-broker.sock")) &&
    existsSync(join(rootDir, "protected", "keychain-broker.token"))
  );
}

describe("secure-keys CI backend resolution", () => {
  beforeEach(() => {
    _resetBackend();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    _setStorePath(STORE_PATH);
  });

  afterEach(() => {
    _setStorePath(null);
    _resetBackend();
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // Q1: Is setSecureKey using the keychain broker or the .enc file?
  // -------------------------------------------------------------------------
  describe("Q1: which backend does setSecureKey resolve to", () => {
    test("sync setSecureKey always writes to the encrypted file store, never the keychain", () => {
      /**
       * Verifies that the sync setSecureKey path delegates exclusively to the
       * encrypted-at-rest file store, regardless of broker availability.
       */

      // GIVEN a clean environment with no prior keys
      expect(existsSync(STORE_PATH)).toBe(false);

      // WHEN we write a key via the sync API
      const ok = setSecureKey("ci-test-key", "ci-test-value");

      // THEN the write succeeds
      expect(ok).toBe(true);

      // AND the encrypted store file was created on disk
      expect(existsSync(STORE_PATH)).toBe(true);

      // AND we can read it back via the sync getter (also encrypted-store-only)
      expect(getSecureKey("ci-test-key")).toBe("ci-test-value");
    });

    test("getBackendType reports the resolved backend for this environment", () => {
      /**
       * Reports whether the broker (macOS keychain via Unix socket) is
       * reachable or whether the encrypted file store is used.
       */

      // WHEN we query the backend type
      const backend = getBackendType();

      // THEN the result depends on whether the broker is present
      if (isBrokerPresent()) {
        expect(backend).toBe("broker");
      } else {
        expect(backend).toBe("encrypted");
      }
    });

    test("setSecureKeyAsync falls back to encrypted store when broker is unavailable", async () => {
      /**
       * Verifies that the async path, which prefers the broker, gracefully
       * falls back to the encrypted file store when no broker is running.
       */

      // GIVEN the broker is not available
      const brokerPresent = isBrokerPresent();
      if (!brokerPresent) {
        const broker = createBrokerClient();
        expect(broker.isAvailable()).toBe(false);
      }

      // WHEN we write a key via the async API
      const ok = await setSecureKeyAsync("ci-async-key", "ci-async-value");

      // THEN the write succeeds (via broker or encrypted store fallback)
      expect(ok).toBe(true);

      // AND the value is readable from both sync and async getters
      expect(getSecureKey("ci-async-key")).toBe("ci-async-value");
      expect(await getSecureKeyAsync("ci-async-key")).toBe("ci-async-value");
    });
  });

  // -------------------------------------------------------------------------
  // Q2: If the broker were available, would keychain access work?
  // -------------------------------------------------------------------------
  describe("Q2: broker availability in CI", () => {
    test("the keychain broker reflects its actual availability", () => {
      /**
       * The broker requires the Vellum macOS desktop app to be running,
       * which exposes a Unix domain socket at <rootDir>/keychain-broker.sock.
       * In CI, the app is not installed, so the broker is unavailable.
       * On developer machines with the app, it may be available.
       */

      // WHEN we create a real (unmocked) broker client
      const broker = createBrokerClient();

      // THEN availability matches whether the socket + token exist
      expect(broker.isAvailable()).toBe(isBrokerPresent());
    });

    test("broker.ping returns null when the broker is unreachable", async () => {
      /**
       * Confirms that attempting to contact the broker when it is
       * unreachable fails gracefully (returns null) rather than
       * throwing or hanging.
       */

      if (isBrokerPresent()) {
        console.log("Broker is present — skipping unreachable ping test");
        return;
      }

      // GIVEN a real broker client in an environment without the macOS app
      const broker = createBrokerClient();

      // WHEN we attempt to ping the broker
      const result = await broker.ping();

      // THEN we get null (unreachable), not an error
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Q3: Why is the broker unavailable?
  // -------------------------------------------------------------------------
  describe("Q3: why the broker is unavailable in CI", () => {
    test("broker socket path does not exist when broker is unavailable", () => {
      /**
       * The broker communicates over a Unix domain socket created by the
       * macOS app. When unavailable, this socket file does not exist.
       */

      if (isBrokerPresent()) {
        console.log("Broker is present — skipping missing-socket assertion");
        return;
      }

      // GIVEN the expected socket path derived from getRootDir()
      const socketPath = join(getRootDir(), "keychain-broker.sock");

      // THEN the socket file does not exist
      expect(existsSync(socketPath)).toBe(false);
    });

    test("broker token file does not exist when broker is unavailable", () => {
      /**
       * The broker requires an auth token written by the macOS app at
       * <rootDir>/protected/keychain-broker.token. Without this token,
       * even if the socket existed, authentication would fail.
       */

      if (isBrokerPresent()) {
        console.log("Broker is present — skipping missing-token assertion");
        return;
      }

      // GIVEN the expected token path derived from getRootDir()
      const tokenPath = join(
        getRootDir(),
        "protected",
        "keychain-broker.token",
      );

      // THEN the token file does not exist
      expect(existsSync(tokenPath)).toBe(false);
    });

    test("environment context: platform and CI indicators", () => {
      /**
       * Documents the runtime environment so CI logs clearly show
       * whether this is macOS or Linux, and whether CI env vars are set.
       */

      const env = {
        platform: platform(),
        hostname: hostname(),
        user: userInfo().username,
        isCI: !!(
          process.env.CI ||
          process.env.GITHUB_ACTIONS ||
          process.env.RUNNER_OS
        ),
        runnerOS: process.env.RUNNER_OS ?? "(not set)",
        rootDir: getRootDir(),
        brokerPresent: isBrokerPresent(),
      };

      // Log environment context for CI visibility
      console.log("CI Environment Context:", JSON.stringify(env, null, 2));

      // The encrypted store works on all platforms
      const ok = setSecureKey("platform-test", "works-on-" + env.platform);
      expect(ok).toBe(true);
      expect(getSecureKey("platform-test")).toBe("works-on-" + env.platform);
    });
  });
});
