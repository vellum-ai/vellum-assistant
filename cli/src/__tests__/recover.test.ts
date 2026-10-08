import { resolveLockfilePaths } from "@vellumai/local-mode";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as osModule from "node:os";
import { basename, join } from "node:path";

import type { AssistantEntry } from "../lib/assistant-config.js";
import * as localModule from "../lib/local.js";
import * as stepRunnerModule from "../lib/step-runner.js";

// Captured real exports — afterAll restores these so module mocks don't
// leak into other test files in the same `bun test` run.
const realLocal = {
  generateLocalSigningKey: localModule.generateLocalSigningKey,
  startLocalDaemon: localModule.startLocalDaemon,
  startGateway: localModule.startGateway,
  startCes: localModule.startCes,
};
const realExec = stepRunnerModule.exec;

// Prevent real daemon / gateway / CES from starting
const startLocalDaemonMock = mock(async () => {});
const startGatewayMock = mock<typeof localModule.startGateway>(
  async () => "http://127.0.0.1:7831",
);
const startCesMock = mock(async () => {});

// Capture exec calls without running real tar
const execMock = mock(async (_cmd: string, _args: string[]) => {});

beforeAll(() => {
  mock.module("../lib/local.js", () => ({
    generateLocalSigningKey: () => "deadbeefdeadbeefdeadbeefdeadbeef",
    startLocalDaemon: startLocalDaemonMock,
    startGateway: startGatewayMock,
    startCes: startCesMock,
  }));
  mock.module("../lib/step-runner.js", () => ({ exec: execMock }));
});

afterAll(() => {
  mock.module("../lib/local.js", () => realLocal);
  mock.module("../lib/step-runner.js", () => ({ exec: realExec }));
});

import { recover } from "../commands/recover.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const testDir = mkdtempSync(join(tmpdir(), "cli-recover-test-"));
const originalArgv = [...process.argv];
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
const originalXdgData = process.env.XDG_DATA_HOME;

// Directories that getRetiredDir() will use when XDG_DATA_HOME is overridden
const retiredDir = join(testDir, "vellum", "retired");

function makeEntry(assistantId: string, instanceDir: string): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: "http://127.0.0.1:7831",
    cloud: "local",
    guardianBootstrapSecret: "existing-bootstrap",
    resources: {
      instanceDir,
      daemonPort: 7801,
      gatewayPort: 7831,
      qdrantPort: 6334,
      cesPort: 7790,
      signingKey: "ab".repeat(32),
    },
  };
}

function writeArchiveFixtures(
  name: string,
  entry: AssistantEntry,
): {
  archivePath: string;
  metadataPath: string;
  extractedPath: string;
} {
  mkdirSync(retiredDir, { recursive: true });
  const archivePath = join(retiredDir, `${name}.tar.gz`);
  const metadataPath = join(retiredDir, `${name}.json`);
  // The staging dir is what tar extracts — <archive>.staging relative to retiredDir
  const extractedPath = join(retiredDir, basename(archivePath) + ".staging");

  // Write a placeholder archive file (exec is mocked; content doesn't matter)
  writeFileSync(archivePath, "");
  writeFileSync(metadataPath, JSON.stringify(entry, null, 2) + "\n");
  // Create the staging dir that tar would have created
  mkdirSync(extractedPath, { recursive: true });

  return { archivePath, metadataPath, extractedPath };
}

let homeSpy: ReturnType<typeof spyOn>;
let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  homeSpy = spyOn(osModule, "homedir").mockReturnValue(join(testDir, "home"));
  mkdirSync(homedir(), { recursive: true });
  // Route lockfile and retired archives to the temp directory
  process.env.VELLUM_LOCKFILE_DIR = testDir;
  process.env.XDG_DATA_HOME = testDir;
  // Write an empty lockfile so saveAssistantEntry has a dir to write to
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    resolveLockfilePaths(process.env)[0]!,
    JSON.stringify({ assistants: [] }) + "\n",
  );

  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
    throw new Error(`process.exit(${_code})`);
  });

  execMock.mockClear();
  startLocalDaemonMock.mockClear();
  startGatewayMock.mockClear();
  startCesMock.mockClear();
});

afterEach(() => {
  homeSpy.mockRestore();
  process.argv = [...originalArgv];
  process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
  process.env.XDG_DATA_HOME = originalXdgData;
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
  // Clean up per-test artifacts inside testDir/vellum/
  if (existsSync(join(testDir, "vellum"))) {
    rmSync(join(testDir, "vellum"), { recursive: true, force: true });
  }
});

// Runs after all tests finish
afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  process.argv = [...originalArgv];
  if (originalLockfileDir !== undefined) {
    process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
  } else {
    delete process.env.VELLUM_LOCKFILE_DIR;
  }
  if (originalXdgData !== undefined) {
    process.env.XDG_DATA_HOME = originalXdgData;
  } else {
    delete process.env.XDG_DATA_HOME;
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("recover --help", () => {
  test("prints usage, description, and examples then exits 0", async () => {
    process.argv = ["bun", "vellum", "recover", "--help"];
    await expect(recover()).rejects.toThrow("process.exit(0)");
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Usage: vellum recover <name>");
    expect(output).toContain("Examples:");
    expect(output).toContain("vellum recover");
  });
});

describe("recover error cases", () => {
  for (const named of [true, false]) {
    for (const failure of ["missing", "conflict"] as const) {
      test(`${named ? "named" : "default"} recovery ${failure} leaves destination and registry untouched and permits retry`, async () => {
        const name = `retry-${named}-${failure}`;
        const instanceDir = named
          ? join(testDir, "vellum", "assistants", name)
          : homedir();
        const target = named ? instanceDir : join(instanceDir, ".vellum");
        const entry = makeEntry(name, instanceDir);
        delete entry.resources!.signingKey;
        const { archivePath, metadataPath, extractedPath } =
          writeArchiveFixtures(name, entry);
        if (failure === "conflict") {
          const staged = named ? join(extractedPath, ".vellum") : extractedPath;
          for (const [dir, hex] of [
            ["protected", "ab"],
            ["workspace/deprecated", "cd"],
          ]) {
            mkdirSync(join(staged, dir!), { recursive: true });
            writeFileSync(
              join(staged, dir!, "actor-token-signing-key"),
              Buffer.from(hex!.repeat(32), "hex"),
            );
          }
        }
        const registry = resolveLockfilePaths(process.env)[0]!;
        const before = readFileSync(registry, "utf8");
        process.argv = ["bun", "vellum", "recover", name];
        await expect(recover()).rejects.toThrow(`signing key ${failure}`);
        expect(existsSync(target)).toBe(false);
        expect(readFileSync(registry, "utf8")).toBe(before);
        expect(existsSync(archivePath)).toBe(true);
        expect(existsSync(metadataPath)).toBe(true);
        expect(startLocalDaemonMock).not.toHaveBeenCalled();
        expect(startGatewayMock).not.toHaveBeenCalled();
        // Restore the authoritative identity in the archive metadata and retry.
        entry.resources!.signingKey = "ab".repeat(32);
        writeFileSync(metadataPath, JSON.stringify(entry));
        await recover();
        expect(existsSync(target)).toBe(true);
        expect(existsSync(archivePath)).toBe(false);
        expect(startGatewayMock).toHaveBeenCalledTimes(1);
        rmSync(target, { recursive: true, force: true });
      });
    }
  }

  for (const named of [true, false]) {
    test(`recovers ${named ? "named" : "default"} archived legacy identity from staging`, async () => {
      const name = `legacy-${named}`;
      const entry = makeEntry(
        name,
        named ? join(testDir, "vellum", "assistants", name) : homedir(),
      );
      delete entry.resources!.signingKey;
      const { extractedPath } = writeArchiveFixtures(name, entry);
      const dir = join(
        named ? join(extractedPath, ".vellum") : extractedPath,
        "workspace",
        "deprecated",
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "actor-token-signing-key"),
        Buffer.from("cd".repeat(32), "hex"),
      );
      process.argv = ["bun", "vellum", "recover", name];
      await recover();
      expect(startGatewayMock).toHaveBeenCalledWith(
        false,
        expect.objectContaining({ signingKey: "cd".repeat(32) }),
        { signingKey: "cd".repeat(32), bootstrapSecret: "existing-bootstrap" },
      );
      rmSync(
        named ? entry.resources!.instanceDir : join(homedir(), ".vellum"),
        { recursive: true, force: true },
      );
    });
  }

  test("missing identity preserves the archive and starts no processes", async () => {
    const name = "missing-key";
    const entry = makeEntry(name, join(testDir, "vellum", "assistants", name));
    delete entry.resources!.signingKey;
    const { archivePath, metadataPath } = writeArchiveFixtures(name, entry);
    process.argv = ["bun", "vellum", "recover", name];
    await expect(recover()).rejects.toThrow("signing key missing");
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(metadataPath)).toBe(true);
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(startGatewayMock).not.toHaveBeenCalled();
  });

  test("exits 1 when no name is given", async () => {
    process.argv = ["bun", "vellum", "recover"];
    await expect(recover()).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("Usage:");
  });

  test("exits 1 when archive is missing", async () => {
    process.argv = ["bun", "vellum", "recover", "ghost-assistant"];
    await expect(recover()).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain(
      "No retired archive found for 'ghost-assistant'",
    );
  });

  test("throws when metadata has no resources", async () => {
    const name = "no-resources";
    mkdirSync(retiredDir, { recursive: true });
    writeFileSync(join(retiredDir, `${name}.tar.gz`), "");
    const entry: Partial<AssistantEntry> = {
      assistantId: name,
      runtimeUrl: "http://127.0.0.1:7831",
      cloud: "local",
      // resources intentionally omitted
    };
    writeFileSync(
      join(retiredDir, `${name}.json`),
      JSON.stringify(entry, null, 2) + "\n",
    );
    process.argv = ["bun", "vellum", "recover", name];
    await expect(recover()).rejects.toThrow("missing resource configuration");
  });

  test("exits 1 when target .vellum/ already exists", async () => {
    const name = "already-exists";
    const instanceDir = join(testDir, name);
    const entry = makeEntry(name, instanceDir);
    writeArchiveFixtures(name, entry);
    // Pre-create the collision path that recover checks
    mkdirSync(join(instanceDir, ".vellum"), { recursive: true });
    process.argv = ["bun", "vellum", "recover", name];
    await expect(recover()).rejects.toThrow("process.exit(1)");
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("already exists");
  });
});

describe("recover extraction path — default instance (instanceDir === homedir())", () => {
  test("extracts to retiredDir and renames staging dir to instanceDir/.vellum", async () => {
    const name = "default-instance";
    const entry = makeEntry(name, homedir());
    const { archivePath, extractedPath } = writeArchiveFixtures(name, entry);

    const expectedTargetDir = join(homedir(), ".vellum");

    try {
      process.argv = ["bun", "vellum", "recover", name];
      await recover();

      // exec must have been called with -C retiredDir, NOT -C homedir()
      expect(execMock).toHaveBeenCalledTimes(1);
      const [cmd, args] = execMock.mock.calls[0] as [string, string[]];
      expect(cmd).toBe("tar");
      expect(args).toContain("-C");
      const cIndex = args.indexOf("-C");
      expect(args[cIndex + 1]).toBe(retiredDir);
      expect(args[cIndex + 1]).not.toBe(homedir());

      // Staging dir was renamed to the correct target
      expect(existsSync(extractedPath)).toBe(false);
      expect(existsSync(expectedTargetDir)).toBe(true);

      // Archive and metadata were cleaned up
      expect(existsSync(archivePath)).toBe(false);

      // Daemon and gateway were started
      expect(startLocalDaemonMock).toHaveBeenCalledTimes(1);
      expect(startGatewayMock).toHaveBeenCalledTimes(1);
      expect(startGatewayMock.mock.calls[0]).toEqual([
        false,
        expect.objectContaining({ signingKey: "ab".repeat(32) }),
        { signingKey: "ab".repeat(32), bootstrapSecret: "existing-bootstrap" },
      ]);
    } finally {
      rmSync(expectedTargetDir, { recursive: true, force: true });
    }
  });
});

describe("recover extraction path — named instance (instanceDir !== homedir())", () => {
  test("extracts to retiredDir and renames staging dir to instanceDir directly", async () => {
    const name = "named-instance";
    const instanceDir = join(testDir, "custom-location", name);
    const entry = makeEntry(name, instanceDir);
    const { archivePath, extractedPath } = writeArchiveFixtures(name, entry);

    // Named instance: targetDir is instanceDir itself (not instanceDir/.vellum)
    const expectedTargetDir = instanceDir;
    // Parent dir must exist for renameSync
    mkdirSync(join(testDir, "custom-location"), { recursive: true });

    process.argv = ["bun", "vellum", "recover", name];
    await recover();

    // exec must have been called with -C retiredDir
    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("tar");
    const cIndex = args.indexOf("-C");
    expect(args[cIndex + 1]).toBe(retiredDir);

    // Staging dir was renamed to instanceDir (not instanceDir/.vellum)
    expect(existsSync(extractedPath)).toBe(false);
    expect(existsSync(expectedTargetDir)).toBe(true);

    // Archive cleaned up
    expect(existsSync(archivePath)).toBe(false);

    // Daemon and gateway were started
    expect(startLocalDaemonMock).toHaveBeenCalledTimes(1);
    expect(startGatewayMock).toHaveBeenCalledTimes(1);
    expect(startGatewayMock.mock.calls[0]).toEqual([
      false,
      expect.objectContaining({ signingKey: "ab".repeat(32) }),
      { signingKey: "ab".repeat(32), bootstrapSecret: "existing-bootstrap" },
    ]);
  });

  test("creates parent directories of instanceDir when they do not exist", async () => {
    const name = "deep-nested-instance";
    // Use a path whose parent directory does not yet exist
    const instanceDir = join(testDir, "new-parent", "deeper", name);
    const entry = makeEntry(name, instanceDir);
    const { archivePath, extractedPath } = writeArchiveFixtures(name, entry);

    process.argv = ["bun", "vellum", "recover", name];
    await recover();

    expect(existsSync(extractedPath)).toBe(false);
    expect(existsSync(instanceDir)).toBe(true);
    expect(existsSync(archivePath)).toBe(false);

    rmSync(instanceDir, { recursive: true, force: true });
  });
});
