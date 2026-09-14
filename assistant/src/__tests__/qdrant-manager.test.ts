import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

const testDataDir = process.env.VELLUM_WORKSPACE_DIR!;

import {
  describeQdrantStartFailure,
  QdrantManager,
  QdrantStartError,
  resolveQdrantReleaseAsset,
} from "../persistence/embeddings/qdrant-manager.js";

/**
 * Short timeouts so tests complete fast but with enough headroom for CI and
 * for Bun's subprocess-exit detection. Bun's `proc.exited` promise can take
 * ~80–150ms to resolve on macOS after a subprocess exits (especially the
 * first cold spawn in a test run), so `readyzTimeoutMs` must be comfortably
 * above that to reliably catch "exited before becoming ready" cases.
 */
const FAST_TIMEOUTS = {
  readyzPollIntervalMs: 5,
  readyzTimeoutMs: 500,
  shutdownGraceMs: 50,
} as const;

function placeFakeBinary(script: string): string {
  const binaryPath = join(testDataDir, "data", "qdrant", "bin", "qdrant");
  writeFileSync(binaryPath, script);
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

let nextPort = 16500;
function getTestPort(): number {
  return nextPort++;
}

const qdrantDir = join(testDataDir, "data", "qdrant");
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

  test("selects the pinned Windows x64 zip release", () => {
    expect(resolveQdrantReleaseAsset("win32", "x64")).toEqual({
      binaryName: "qdrant.exe",
      filename: "qdrant-x86_64-pc-windows-msvc.zip",
      format: "zip",
      sha256:
        "9d3b1d1fa58566bc71709347c4c9b83a0111d23a550daa93c3ee48e3150c4470",
    });
  });

  test("falls back to the x64 zip release on Windows arm64", () => {
    expect(resolveQdrantReleaseAsset("win32", "arm64")).toEqual(
      resolveQdrantReleaseAsset("win32", "x64"),
    );
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
      const pidPath = join(testDataDir, "data", "qdrant", "qdrant.pid");
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
      const pidPath = join(testDataDir, "data", "qdrant", "qdrant.pid");
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
      const pidPath = join(testDataDir, "data", "qdrant", "qdrant.pid");
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
      const pidPath = join(testDataDir, "data", "qdrant", "qdrant.pid");
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
      const pidPath = join(testDataDir, "data", "qdrant", "qdrant.pid");

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

      // start() should now reject because process was killed. Either the
      // readyz timeout fires first or waitForReady notices the process
      // exited — accept both since the race depends on timing.
      await expect(startPromise).rejects.toThrow(
        /did not become ready|exited with code/,
      );
    }, 10_000);

    test("stop() escalates to SIGKILL after grace period", async () => {
      const pidPath = join(testDataDir, "data", "qdrant", "qdrant.pid");

      // Binary that ignores SIGTERM. Cannot use `exec` here: `exec sleep 300`
      // replaces the shell with `sleep`, dropping the trap and letting SIGTERM
      // terminate the process immediately. Keep the shell alive as the
      // foreground PID so the trap applies, and run sleep in a loop since the
      // orphan gets reaped when the shell is SIGKILLed at the end.
      placeFakeBinary('#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done');

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      const startPromise = mgr.start();
      // Give the shell enough time to install its SIGTERM trap. 50ms is
      // unreliable on cold spawns — bun takes ~100ms to fully settle the
      // child before signals hit a trap-aware state.
      await Bun.sleep(150);

      expect(existsSync(pidPath)).toBe(true);

      const stopStart = Date.now();
      await mgr.stop();
      const stopElapsed = Date.now() - stopStart;

      // Grace period is 50ms with FAST_TIMEOUTS — should wait at least that long
      expect(stopElapsed).toBeGreaterThanOrEqual(30);
      expect(existsSync(pidPath)).toBe(false);

      // start() rejects because its in-progress waitForReady either times
      // out or observes the SIGKILLed process exit. Accept either outcome.
      await expect(startPromise).rejects.toThrow(
        /did not become ready|exited with code/,
      );
    }, 10_000);
  });

  // ── Start Failure Cleanup ────────────────────────────────────

  describe("start failure cleanup", () => {
    test("cleans up process on readyz timeout", async () => {
      const pidPath = join(testDataDir, "data", "qdrant", "qdrant.pid");

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

    test("fails fast with exit code when process exits immediately", async () => {
      const pidPath = join(testDataDir, "data", "qdrant", "qdrant.pid");

      // GIVEN a Qdrant binary that exits immediately with code 1
      placeFakeBinary("#!/bin/sh\nexit 1");

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      // WHEN we start the manager
      const startTime = Date.now();
      await expect(mgr.start()).rejects.toThrow(
        /exited with code \d+ before becoming ready/,
      );
      const elapsed = Date.now() - startTime;

      // THEN it fails fast (well under the 100ms readyz timeout)
      expect(elapsed).toBeLessThan(FAST_TIMEOUTS.readyzTimeoutMs);

      // AND the PID file is cleaned up
      expect(existsSync(pidPath)).toBe(false);
    }, 10_000);

    test("includes stderr in error when process crashes", async () => {
      // GIVEN a Qdrant binary that writes to stderr before crashing
      placeFakeBinary('#!/bin/sh\necho "fatal: storage corrupted" >&2\nexit 1');

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      // WHEN we start the manager
      // THEN the error includes the stderr output
      await expect(mgr.start()).rejects.toThrow("storage corrupted");
    }, 10_000);

    test("includes stdout in error when process crashes", async () => {
      // GIVEN a binary that reports its failure on stdout, as Qdrant does for
      // panics, while stderr carries only unrelated allocator noise
      placeFakeBinary(
        '#!/bin/sh\necho "<jemalloc>: option background_thread currently supports pthread only" >&2\n' +
          'echo "Panic occurred: Failed to load local shard"\nexit 101',
      );

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      // WHEN we start the manager
      // THEN the error carries the stdout explanation, not just the noise
      await expect(mgr.start()).rejects.toThrow("Failed to load local shard");
    }, 10_000);

    test("classifies a crash as an exit with its code and captured output", async () => {
      // The reporter must not have to parse the message: the step, the exit
      // code and the raw streams travel as fields.
      placeFakeBinary(
        '#!/bin/sh\necho "Panic occurred: no such shard"\nexit 101',
      );

      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${getTestPort()}`,
        ...FAST_TIMEOUTS,
      });

      let caught: unknown;
      await mgr.start().catch((err) => {
        caught = err;
      });

      expect(caught).toBeInstanceOf(QdrantStartError);
      const err = caught as QdrantStartError;
      expect(err.kind).toBe("exited");
      expect(err.exitCode).toBe(101);
      expect(err.stdout).toContain("no such shard");
    }, 10_000);

    test("classifies a readiness timeout as not_ready with no exit code", async () => {
      placeFakeBinary("#!/bin/sh\nexec sleep 300");

      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${getTestPort()}`,
        ...FAST_TIMEOUTS,
      });

      let caught: unknown;
      await mgr.start().catch((err) => {
        caught = err;
      });

      expect(caught).toBeInstanceOf(QdrantStartError);
      expect((caught as QdrantStartError).kind).toBe("not_ready");
      expect((caught as QdrantStartError).exitCode).toBeNull();
    }, 10_000);
  });

  describe("describeQdrantStartFailure", () => {
    const dataDir = "/home/example/workspace-data";
    const failure = (stdout: string, kind: "exited" | "not_ready" = "exited") =>
      new QdrantStartError(
        "boom",
        kind,
        kind === "exited" ? 101 : null,
        stdout,
        "",
      );

    test("takes the reason from the last panic marker, after the backtrace", () => {
      const stdout =
        "   0: backtrace frame\n   1: another frame\n" +
        "ERROR qdrant::startup: Panic occurred in file mod.rs at line 301: " +
        "Failed to load local shard";

      expect(describeQdrantStartFailure(failure(stdout), dataDir)).toEqual({
        kind: "exited",
        exit_code: 101,
        panic:
          "Panic occurred in file mod.rs at line 301: Failed to load local shard",
      });
    });

    test("replaces the data directory wherever it appears", () => {
      const stdout = `Panic occurred: cannot open ${dataDir}/qdrant/collections/x and ${dataDir}/qdrant/wal`;

      expect(describeQdrantStartFailure(failure(stdout), dataDir).panic).toBe(
        "Panic occurred: cannot open <data>/qdrant/collections/x and <data>/qdrant/wal",
      );
    });

    test("falls back to the last stdout line when Qdrant died without panicking", () => {
      const stdout =
        "INFO starting\nERROR Address already in use (os error 48)\n";

      expect(describeQdrantStartFailure(failure(stdout), dataDir).panic).toBe(
        "ERROR Address already in use (os error 48)",
      );
    });

    test("reports no reason for a silent timeout", () => {
      expect(
        describeQdrantStartFailure(failure("", "not_ready"), dataDir),
      ).toEqual({ kind: "not_ready", exit_code: null, panic: null });
    });

    /**
     * The telemetry server's measure: JSON with every code unit above 0x7E
     * escaped to six ASCII bytes (`jsonByteLength` in
     * `telemetry-wire.generated.ts`), minus the enclosing quotes.
     */
    const serverBytes = (s: string) =>
      JSON.stringify(s).replace(/[^\x00-\x7e]/g, "\\uxxxx").length - 2;

    test("caps an ASCII reason at the byte budget", () => {
      const { panic } = describeQdrantStartFailure(
        failure("Panic occurred: " + "x".repeat(5_000)),
        dataDir,
      );

      expect(panic?.length).toBe(1_024);
      expect(serverBytes(panic!)).toBe(1_024);
    });

    test("caps a non-ASCII reason by the server's escaped size, not by characters", () => {
      // Each CJK character serializes to six bytes on the server, so a
      // character cap would overshoot the budget six-fold and the event would
      // be dropped at ingest.
      const { panic } = describeQdrantStartFailure(
        failure("Panic occurred: " + "測".repeat(2_000)),
        dataDir,
      );

      expect(serverBytes(panic!)).toBeLessThanOrEqual(1_024);
      expect(serverBytes(panic! + "測")).toBeGreaterThan(1_024);
    });

    test("never drops an unclassified failure", () => {
      expect(describeQdrantStartFailure(new Error("nope"), dataDir)).toEqual({
        kind: "unknown",
        exit_code: null,
        panic: null,
      });
    });
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

      const binaryPath = join(testDataDir, "data", "qdrant", "bin", "qdrant");
      expect(existsSync(binaryPath)).toBe(true);
    }, 10_000);
  });

  // ── Symlink Safety ────────────────────────────────────────────

  describe("vellum-qdrant symlink safety", () => {
    test("ignores pre-existing non-symlink vellum-qdrant file", async () => {
      const realMarkerPath = join(qdrantDir, "real-executed.txt");
      const hijackMarkerPath = join(qdrantDir, "hijack-executed.txt");

      placeFakeBinary(`#!/bin/sh\necho real > "${realMarkerPath}"\nexit 1`);

      const hijackPath = join(qdrantBinDir, "vellum-qdrant");
      writeFileSync(
        hijackPath,
        `#!/bin/sh\necho hijack > "${hijackMarkerPath}"\nexit 0`,
      );
      chmodSync(hijackPath, 0o755);

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      await expect(mgr.start()).rejects.toThrow("before becoming ready");
      expect(existsSync(realMarkerPath)).toBe(true);
      expect(existsSync(hijackMarkerPath)).toBe(false);
    }, 10_000);

    test("ignores symlink that does not point to real qdrant binary", async () => {
      const realMarkerPath = join(qdrantDir, "real-executed.txt");
      const hijackMarkerPath = join(qdrantDir, "hijack-executed.txt");

      placeFakeBinary(`#!/bin/sh\necho real > "${realMarkerPath}"\nexit 1`);

      const evilBinaryPath = join(qdrantBinDir, "evil-qdrant");
      writeFileSync(
        evilBinaryPath,
        `#!/bin/sh\necho hijack > "${hijackMarkerPath}"\nexit 0`,
      );
      chmodSync(evilBinaryPath, 0o755);

      const vellumQdrantPath = join(qdrantBinDir, "vellum-qdrant");
      symlinkSync(evilBinaryPath, vellumQdrantPath);

      const port = getTestPort();
      const mgr = new QdrantManager({
        url: `http://127.0.0.1:${port}`,
        ...FAST_TIMEOUTS,
      });

      await expect(mgr.start()).rejects.toThrow("before becoming ready");
      expect(existsSync(realMarkerPath)).toBe(true);
      expect(existsSync(hijackMarkerPath)).toBe(false);
    }, 10_000);
  });
});
