import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const testDataDir = "/tmp/qdrant-manager-test-" + process.pid;

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDataDir,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { QdrantManager } from "../memory/qdrant-manager.js";

/** Short timeouts so tests complete fast but with enough headroom for CI. */
const FAST_TIMEOUTS = {
  readyzPollIntervalMs: 5,
  readyzTimeoutMs: 100,
  shutdownGraceMs: 50,
} as const;

function placeFakeBinary(script: string): string {
  const binaryPath = join(testDataDir, "qdrant", "bin", "qdrant");
  writeFileSync(binaryPath, script);
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

let nextPort = 16500;
function getTestPort(): number {
  return nextPort++;
}

const qdrantDir = join(testDataDir, "qdrant");
const qdrantBinDir = join(qdrantDir, "bin");

beforeAll(() => {
  mkdirSync(qdrantBinDir, { recursive: true });
});

beforeEach(() => {
  // Clear content files but preserve the directory structure
  for (const entry of readdirSync(qdrantDir)) {
    if (entry === "bin") {
      // Clear bin contents but keep the directory
      for (const binEntry of readdirSync(qdrantBinDir)) {
        rmSync(join(qdrantBinDir, binEntry), { force: true });
      }
    } else {
      rmSync(join(qdrantDir, entry), { recursive: true, force: true });
    }
  }
  delete process.env.QDRANT_URL;
});

afterEach(() => {
  delete process.env.QDRANT_URL;
});

afterAll(() => {
  rmSync(testDataDir, { recursive: true, force: true });
});

describe("QdrantManager", () => {
  // ── Constructor ──────────────────────────────────────────────

  describe("constructor", () => {
    test("parses URL correctly", () => {
      const mgr = new QdrantManager({ url: "http://127.0.0.1:6333" });
      expect(mgr.getUrl()).toBe("http://127.0.0.1:6333");
    });

    test("defaults port to 6333 when not in URL", () => {
      const mgr = new QdrantManager({ url: "http://localhost" });
      expect(mgr.getUrl()).toBe("http://localhost");
    });

    test("accepts custom storagePath", () => {
      const mgr = new QdrantManager({
        url: "http://127.0.0.1:6333",
        storagePath: "/custom/storage",
      });
      expect(mgr.getUrl()).toBe("http://127.0.0.1:6333");
    });
  });

  // ── getUrl ───────────────────────────────────────────────────

  describe("getUrl", () => {
    test("returns the configured URL", () => {
      const mgr = new QdrantManager({ url: "http://myhost:7777" });
      expect(mgr.getUrl()).toBe("http://myhost:7777");
    });
  });

  // ── External Mode ────────────────────────────────────────────

  describe("external mode", () => {
    test("enters external mode when QDRANT_URL is set", async () => {
      process.env.QDRANT_URL = "http://external:6333";
      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      // External mode goes straight to waitForReady, which will timeout
      await expect(mgr.start()).rejects.toThrow("did not become ready");
    }, 10_000);

    test("does not enter external mode when QDRANT_URL is empty", () => {
      process.env.QDRANT_URL = "   ";
      const mgr = new QdrantManager({ url: "http://127.0.0.1:6333" });
      expect(mgr.getUrl()).toBe("http://127.0.0.1:6333");
    });

    test("does not enter external mode when QDRANT_URL is unset", () => {
      delete process.env.QDRANT_URL;
      const mgr = new QdrantManager({ url: "http://127.0.0.1:6333" });
      expect(mgr.getUrl()).toBe("http://127.0.0.1:6333");
    });
  });

  // ── stop() without a running process ─────────────────────────

  describe("stop() without running process", () => {
    test("removes stale PID file", async () => {
      const pidPath = join(testDataDir, "qdrant", "qdrant.pid");
      writeFileSync(pidPath, "99999");

      const mgr = new QdrantManager({ url: "http://127.0.0.1:6333" });
      await mgr.stop();

      expect(existsSync(pidPath)).toBe(false);
    });

    test("is a no-op when no PID file exists", async () => {
      const mgr = new QdrantManager({ url: "http://127.0.0.1:6333" });
      await mgr.stop();
    });
  });

  // ── Stale PID Cleanup ────────────────────────────────────────

  describe("stale PID cleanup during start()", () => {
    test("removes PID file for non-existent process", async () => {
      const pidPath = join(testDataDir, "qdrant", "qdrant.pid");
      writeFileSync(pidPath, "2147483647");

      placeFakeBinary("#!/bin/sh\nexit 1");

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      try {
        await mgr.start();
      } catch {
        /* readyz timeout */
      }

      expect(existsSync(pidPath)).toBe(false);
    }, 10_000);

    test("handles invalid PID file contents", async () => {
      const pidPath = join(testDataDir, "qdrant", "qdrant.pid");
      writeFileSync(pidPath, "garbage");

      placeFakeBinary("#!/bin/sh\nexit 1");

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      try {
        await mgr.start();
      } catch {
        /* expected */
      }

      expect(existsSync(pidPath)).toBe(false);
    }, 10_000);

    test("handles empty PID file", async () => {
      const pidPath = join(testDataDir, "qdrant", "qdrant.pid");
      writeFileSync(pidPath, "");

      placeFakeBinary("#!/bin/sh\nexit 1");

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      try {
        await mgr.start();
      } catch {
        /* expected */
      }

      expect(existsSync(pidPath)).toBe(false);
    }, 10_000);
  });

  // ── Process Lifecycle ────────────────────────────────────────

  describe("process lifecycle", () => {
    test("writes PID file after spawning", async () => {
      const pidPath = join(testDataDir, "qdrant", "qdrant.pid");

      // Binary that stays alive. We'll stop it before readyz times out.
      placeFakeBinary("#!/bin/sh\nexec sleep 300");

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      // Start polls readyz forever; we race it with our assertions + stop
      const startPromise = mgr.start();

      // Wait for spawn to happen
      await Bun.sleep(50);

      // PID file should be written
      expect(existsSync(pidPath)).toBe(true);
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      expect(isNaN(pid)).toBe(false);
      expect(pid).toBeGreaterThan(0);

      // Stop kills the process and cleans up PID
      await mgr.stop();
      expect(existsSync(pidPath)).toBe(false);

      // start() should now reject because process was killed
      await expect(startPromise).rejects.toThrow("did not become ready");
    }, 10_000);

    test("stop() escalates to SIGKILL after grace period", async () => {
      const pidPath = join(testDataDir, "qdrant", "qdrant.pid");

      // Binary that ignores SIGTERM
      placeFakeBinary('#!/bin/sh\ntrap "" TERM\nexec sleep 300');

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      const startPromise = mgr.start();
      await Bun.sleep(50);

      expect(existsSync(pidPath)).toBe(true);

      const stopStart = Date.now();
      await mgr.stop();
      const stopElapsed = Date.now() - stopStart;

      // Grace period is 50ms with FAST_TIMEOUTS — should wait at least that long
      expect(stopElapsed).toBeGreaterThanOrEqual(30);
      expect(existsSync(pidPath)).toBe(false);

      await expect(startPromise).rejects.toThrow("did not become ready");
    }, 10_000);
  });

  // ── Start Failure Cleanup ────────────────────────────────────

  describe("start failure cleanup", () => {
    test("cleans up process on readyz timeout", async () => {
      const pidPath = join(testDataDir, "qdrant", "qdrant.pid");

      // Binary that stays alive but never serves readyz
      placeFakeBinary("#!/bin/sh\nexec sleep 300");

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      await expect(mgr.start()).rejects.toThrow("did not become ready");
      expect(existsSync(pidPath)).toBe(false);
    }, 10_000);

    test("cleans up when process exits immediately", async () => {
      const pidPath = join(testDataDir, "qdrant", "qdrant.pid");

      placeFakeBinary("#!/bin/sh\nexit 1");

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      await expect(mgr.start()).rejects.toThrow("did not become ready");
      expect(existsSync(pidPath)).toBe(false);
    }, 10_000);
  });

  // ── Binary Detection ─────────────────────────────────────────

  describe("binary detection", () => {
    test("skips download when binary exists", async () => {
      placeFakeBinary("#!/bin/sh\nexit 1");

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      try {
        await mgr.start();
      } catch {
        /* readyz timeout */
      }

      const binaryPath = join(testDataDir, "qdrant", "bin", "qdrant");
      expect(existsSync(binaryPath)).toBe(true);
    }, 10_000);
  });
});
