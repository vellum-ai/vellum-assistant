import { afterAll, beforeEach, describe, expect, test, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Lockfile + XDG isolation — must be set before any imports that touch the
// real filesystem paths. VELLUM_LOCKFILE_DIR keeps saveAssistantEntry() off
// the real ~/.vellum.lock.json. XDG_DATA_HOME routes the retired-archive
// directory (getRetiredDir()) into a scratch dir.
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "cli-retire-recover-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

const xdgDataHome = mkdtempSync(join(tmpdir(), "cli-retire-recover-xdg-"));
const prevXdg = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = xdgDataHome;

// Mock process.ts — retireLocal() calls stopProcessByPidFile and
// stopOrphanedDaemonProcesses. With no real PID files the PID-file path is
// a no-op, but stopOrphanedDaemonProcesses scans `ps` for vellum-daemon and
// could kill a dev daemon running on the same machine. Stub both to be
// no-ops in the test.
mock.module("../lib/process.js", () => ({
  stopProcessByPidFile: async () => false,
  stopOrphanedDaemonProcesses: async () => false,
}));

import { retireLocal, createArchive } from "../lib/retire-local.js";
import { extractArchive } from "../commands/recover.js";
import {
  saveAssistantEntry,
  type AssistantEntry,
} from "../lib/assistant-config.js";
import { getArchivePath, getMetadataPath } from "../lib/retire-archive.js";
import { DEFAULT_DAEMON_PORT } from "../lib/constants.js";

// Each test creates a fresh instance dir under this scratch root so the
// retire → recover round-trip operates on real files.
const instancesRoot = mkdtempSync(join(tmpdir(), "cli-retire-recover-inst-"));

afterAll(() => {
  rmSync(instancesRoot, { recursive: true, force: true });
  rmSync(testDir, { recursive: true, force: true });
  rmSync(xdgDataHome, { recursive: true, force: true });
  delete process.env.VELLUM_LOCKFILE_DIR;
  if (prevXdg !== undefined) {
    process.env.XDG_DATA_HOME = prevXdg;
  } else {
    delete process.env.XDG_DATA_HOME;
  }
});

function resetLockfile(): void {
  try {
    rmSync(join(testDir, ".vellum.lock.json"));
  } catch {
    // no-op
  }
  try {
    rmSync(join(testDir, ".vellum.lockfile.json"));
  } catch {
    // no-op
  }
}

function resetRetiredDir(): void {
  // getRetiredDir() is `<XDG_DATA_HOME>/vellum/retired` — purge between tests
  // so each test starts with no stale archives from previous runs.
  try {
    rmSync(join(xdgDataHome, "vellum", "retired"), {
      recursive: true,
      force: true,
    });
  } catch {
    // no-op
  }
}

function makeNamedInstanceEntry(
  name: string,
  instanceDir: string,
): AssistantEntry {
  return {
    assistantId: name,
    runtimeUrl: `http://localhost:${DEFAULT_DAEMON_PORT}`,
    cloud: "local",
    resources: {
      instanceDir,
      daemonPort: DEFAULT_DAEMON_PORT,
      gatewayPort: DEFAULT_DAEMON_PORT + 1,
      qdrantPort: DEFAULT_DAEMON_PORT + 2,
      cesPort: DEFAULT_DAEMON_PORT + 3,
      pidFile: join(instanceDir, ".vellum", "vellum.pid"),
    },
  };
}

describe("retire → recover round-trip", () => {
  beforeEach(() => {
    resetLockfile();
    resetRetiredDir();
  });

  test("named instance: archive contents restore to original instanceDir", async () => {
    // GIVEN a named-instance data directory populated with a recognizable
    // marker file inside `.vellum/workspace/`
    const name = "roundtrip-named";
    const instanceDir = join(instancesRoot, name);
    const vellumDir = join(instanceDir, ".vellum");
    const workspaceDir = join(vellumDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const markerPath = join(workspaceDir, "marker.txt");
    writeFileSync(markerPath, "HELLO");

    // AND the lockfile has a matching entry for the instance
    const entry = makeNamedInstanceEntry(name, instanceDir);
    saveAssistantEntry(entry);

    // WHEN we retire the instance with a synchronous archive so the tar
    // finishes before retireLocal() returns
    await retireLocal(name, entry, { backgroundArchive: false });

    // THEN the original instance dir is gone
    expect(existsSync(instanceDir)).toBe(false);

    // AND the archive + metadata exist at the retired-dir location
    const archivePath = getArchivePath(name);
    const metadataPath = getMetadataPath(name);
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(metadataPath)).toBe(true);

    // AND no orphaned `<name>.tar.gz.staging` directory leaks anywhere on disk
    expect(existsSync(`${archivePath}.staging`)).toBe(false);

    // WHEN we extract the archive via the recover helper
    await extractArchive(archivePath, entry);

    // THEN the marker file is restored at its original path, byte-identical
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("HELLO");

    // AND no wrapper directory (e.g. `<name>.tar.gz.staging/`) was created in
    // instanceDir, homedir, or the retired dir
    const badPaths = [
      join(instanceDir, `${name}.tar.gz.staging`),
      join(xdgDataHome, `${name}.tar.gz.staging`),
      join(xdgDataHome, "vellum", "retired", `${name}.tar.gz.staging`),
    ];
    for (const p of badPaths) {
      expect(existsSync(p)).toBe(false);
    }
  });

  test("named instance: full instance dir contents are archived (not just .vellum/)", async () => {
    // GIVEN a named-instance data directory with files both under `.vellum/`
    // and at the instance-dir top level (e.g. a top-level config file)
    const name = "roundtrip-fullinstance";
    const instanceDir = join(instancesRoot, name);
    const vellumDir = join(instanceDir, ".vellum");
    mkdirSync(vellumDir, { recursive: true });
    const topLevelPath = join(instanceDir, "top-level.txt");
    writeFileSync(topLevelPath, "TOP");
    const vellumFilePath = join(vellumDir, "inside-vellum.txt");
    writeFileSync(vellumFilePath, "INSIDE");

    const entry = makeNamedInstanceEntry(name, instanceDir);
    saveAssistantEntry(entry);

    // WHEN retire + recover round-trip
    await retireLocal(name, entry, { backgroundArchive: false });
    const archivePath = getArchivePath(name);
    await extractArchive(archivePath, entry);

    // THEN both the top-level file AND the nested .vellum file are restored
    expect(readFileSync(topLevelPath, "utf-8")).toBe("TOP");
    expect(readFileSync(vellumFilePath, "utf-8")).toBe("INSIDE");
  });

  test("createArchive(synchronous) writes archive with no wrapper directory", () => {
    // GIVEN a staging dir with two recognizable files
    const stagingDir = mkdtempSync(join(tmpdir(), "cli-retire-staging-"));
    writeFileSync(join(stagingDir, "a.txt"), "A");
    mkdirSync(join(stagingDir, "sub"), { recursive: true });
    writeFileSync(join(stagingDir, "sub", "b.txt"), "B");

    const archivePath = join(
      mkdtempSync(join(tmpdir(), "cli-retire-archive-")),
      "test.tar.gz",
    );

    // WHEN createArchive runs synchronously
    createArchive({ archivePath, stagingDir, background: false });

    // THEN the archive file exists and the staging dir is removed
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(stagingDir)).toBe(false);

    // AND extracting it into a fresh dir reproduces the contents at the root
    // (no `<basename(stagingDir)>/` wrapper)
    const extractDir = mkdtempSync(join(tmpdir(), "cli-retire-extract-"));
    const res = spawnSync("tar", ["xzf", archivePath, "-C", extractDir], {
      stdio: "inherit",
    });
    expect(res.status).toBe(0);
    expect(readFileSync(join(extractDir, "a.txt"), "utf-8")).toBe("A");
    expect(readFileSync(join(extractDir, "sub", "b.txt"), "utf-8")).toBe("B");

    rmSync(extractDir, { recursive: true, force: true });
  });
});
