/**
 * Diagnostic tests that run WITHOUT mocks to verify which secure-key
 * backend is actually used in the current environment (CI or local).
 *
 * Designed to run on macOS CI runners (macos-15) to answer:
 *   1. Is setSecureKey using the keychain broker or the encrypted file store?
 *   2. If it is trying to use the keychain, does it work?
 *   3. If it doesn't work, why not?
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { arch, hostname, platform, userInfo } from "node:os";
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

const IS_MACOS = platform() === "darwin";

/** True when the broker socket + token both exist on disk. */
function isBrokerPresent(): boolean {
  const rootDir = getRootDir();
  return (
    existsSync(join(rootDir, "keychain-broker.sock")) &&
    existsSync(join(rootDir, "protected", "keychain-broker.token"))
  );
}

/** Run a shell command and return stdout, or the error message on failure. */
function shell(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5_000 }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `[error] ${message}`;
  }
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
    test("sync setSecureKey writes to the encrypted file store", () => {
      /**
       * The sync setSecureKey path always delegates to the encrypted-at-rest
       * file store, regardless of broker availability.
       */

      // GIVEN a clean environment with no prior keys
      expect(existsSync(STORE_PATH)).toBe(false);

      // WHEN we write a key via the sync API
      const ok = setSecureKey("ci-test-key", "ci-test-value");

      // THEN the write succeeds and creates the encrypted store file
      expect(ok).toBe(true);
      expect(existsSync(STORE_PATH)).toBe(true);

      // AND the value round-trips through the sync getter
      expect(getSecureKey("ci-test-key")).toBe("ci-test-value");
    });

    test("getBackendType reports which backend resolved", () => {
      /**
       * Logs and asserts the resolved backend. On macOS CI without the
       * desktop app, this should be "encrypted".
       */

      // WHEN we query the backend type
      const backend = getBackendType();
      const brokerPresent = isBrokerPresent();

      console.log(
        `[Q1] getBackendType() = "${backend}", brokerPresent = ${brokerPresent}`,
      );

      // THEN it matches the broker's actual presence
      if (brokerPresent) {
        expect(backend).toBe("broker");
      } else {
        expect(backend).toBe("encrypted");
      }
    });

    test("setSecureKeyAsync resolves correctly regardless of broker state", async () => {
      /**
       * The async path tries the broker first and falls back to the
       * encrypted file store. Either way the write must succeed.
       */

      // GIVEN the current broker state
      const brokerPresent = isBrokerPresent();
      console.log(`[Q1] brokerPresent = ${brokerPresent} before async write`);

      // WHEN we write a key via the async API
      const ok = await setSecureKeyAsync("ci-async-key", "ci-async-value");

      // THEN the write succeeds
      expect(ok).toBe(true);

      // AND readable from both sync and async getters
      expect(getSecureKey("ci-async-key")).toBe("ci-async-value");
      expect(await getSecureKeyAsync("ci-async-key")).toBe("ci-async-value");
    });
  });

  // -------------------------------------------------------------------------
  // Q2: If it is trying to use the keychain, does it work?
  // -------------------------------------------------------------------------
  describe("Q2: does keychain/broker access work", () => {
    test("broker client reports actual availability and ping result", async () => {
      /**
       * Creates a real broker client and probes it. Logs the result
       * so CI output shows whether the broker is reachable.
       */

      // WHEN we create a real broker client and probe it
      const broker = createBrokerClient();
      const available = broker.isAvailable();
      const pingResult = available ? await broker.ping() : null;

      console.log(
        `[Q2] broker.isAvailable() = ${available}, ping = ${JSON.stringify(pingResult)}`,
      );

      // THEN availability matches filesystem presence
      expect(available).toBe(isBrokerPresent());

      // AND if unavailable, ping returns null (graceful failure, no hang)
      if (!available) {
        expect(pingResult).toBeNull();
      }
    });

    test("macOS keychain state via security CLI", () => {
      /**
       * On macOS, probes the system keychain using the security CLI
       * to show default keychain, keychain list, and whether basic
       * keychain operations are possible. Logs everything for CI.
       */

      if (!IS_MACOS) {
        console.log("[Q2] Not macOS — skipping keychain CLI probe");
        return;
      }

      const defaultKeychain = shell("security default-keychain 2>&1");
      const keychainList = shell("security list-keychains -d user 2>&1");
      const identities = shell("security find-identity -v -p codesigning 2>&1");

      console.log("[Q2] macOS keychain diagnostics:");
      console.log(`  default-keychain: ${defaultKeychain}`);
      console.log(`  list-keychains: ${keychainList}`);
      console.log(`  find-identity: ${identities}`);

      // No assertion — this test exists purely for diagnostic output.
      // The logged values answer whether the macOS keychain is accessible.
      expect(true).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Q3: If it doesn't work, why not?
  // -------------------------------------------------------------------------
  describe("Q3: why the broker is unavailable", () => {
    test("broker socket and token file presence", () => {
      /**
       * Checks whether the broker's required files exist and logs
       * their state. The broker needs both a Unix domain socket and
       * an auth token file written by the macOS desktop app.
       */

      const rootDir = getRootDir();
      const socketPath = join(rootDir, "keychain-broker.sock");
      const tokenPath = join(rootDir, "protected", "keychain-broker.token");
      const socketExists = existsSync(socketPath);
      const tokenExists = existsSync(tokenPath);

      console.log(`[Q3] rootDir = ${rootDir}`);
      console.log(`[Q3] broker socket (${socketPath}): exists=${socketExists}`);
      console.log(`[Q3] broker token  (${tokenPath}): exists=${tokenExists}`);

      // Log what IS in the root dir to see what the runner has
      if (existsSync(rootDir)) {
        const entries = readdirSync(rootDir);
        console.log(`[Q3] contents of ${rootDir}: ${JSON.stringify(entries)}`);
        const protectedDir = join(rootDir, "protected");
        if (existsSync(protectedDir)) {
          const protectedEntries = readdirSync(protectedDir);
          console.log(
            `[Q3] contents of ${protectedDir}: ${JSON.stringify(protectedEntries)}`,
          );
        } else {
          console.log(`[Q3] ${protectedDir} does not exist`);
        }
      } else {
        console.log(`[Q3] ${rootDir} does not exist at all`);
      }

      // Assertion: if broker reports unavailable, at least one file is missing
      const broker = createBrokerClient();
      if (!broker.isAvailable()) {
        expect(socketExists && tokenExists).toBe(false);
      }
    });

    test("full environment context for CI logs", () => {
      /**
       * Dumps complete environment context so the CI log provides a
       * single place to see platform, user, paths, and broker state.
       */

      const rootDir = getRootDir();
      const env = {
        platform: platform(),
        arch: arch(),
        hostname: hostname(),
        user: userInfo().username,
        homedir: userInfo().homedir,
        isCI: !!(
          process.env.CI ||
          process.env.GITHUB_ACTIONS ||
          process.env.RUNNER_OS
        ),
        runnerOS: process.env.RUNNER_OS ?? "(not set)",
        rootDir,
        storePath: join(rootDir, "protected", "keys.enc"),
        brokerSocketPath: join(rootDir, "keychain-broker.sock"),
        brokerTokenPath: join(rootDir, "protected", "keychain-broker.token"),
        brokerPresent: isBrokerPresent(),
        backendType: getBackendType(),
        rootDirExists: existsSync(rootDir),
      };

      console.log(
        "[Q3] Full environment context:",
        JSON.stringify(env, null, 2),
      );

      // Verify the encrypted store works on this platform
      const ok = setSecureKey("platform-test", "works-on-" + env.platform);
      expect(ok).toBe(true);
      expect(getSecureKey("platform-test")).toBe("works-on-" + env.platform);
    });
  });
});
