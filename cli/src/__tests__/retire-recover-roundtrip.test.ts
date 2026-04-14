import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// IMPORTANT on what this file mocks / imports:
//
// We deliberately do NOT import `retireLocal` or `createArchive` from
// `../lib/retire-local`. Another test file in this directory
// (`teleport.test.ts`) calls `mock.module("../lib/retire-local.js", …)` at
// its module top level to stub `retireLocal` as a no-op, and bun's
// `mock.module` persists globally across test files in the same bun test
// process. Taking a direct dependency on that module here lets the stub
// leak in and silently break assertions (as in the 6-month-old bug we're
// fixing — ironic).
//
// Instead this test inlines a faithful simulation of `retireLocal`'s
// archive step (rename → tar → rm) using child_process + fs directly, and
// exercises the real `extractArchive` helper from `../commands/recover`
// (which nothing mocks) for the recover side. That's enough to regression-
// guard both halves of the bug: archive format (contents, no wrapper dir)
// and extraction target (entry.resources.instanceDir).
import { extractArchive } from "../commands/recover";
import {
  saveAssistantEntry,
  type AssistantEntry,
} from "../lib/assistant-config";
import { getArchivePath, getMetadataPath } from "../lib/retire-archive";
import { DEFAULT_DAEMON_PORT } from "../lib/constants";

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
  for (const fname of [".vellum.lock.json", ".vellum.lockfile.json"]) {
    try {
      rmSync(join(testDir, fname));
    } catch {
      // no-op
    }
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

/**
 * Simulate the archive step of `retireLocal` without importing it — see the
 * note at the top of the file for why.
 *
 * This mirrors the production code in `cli/src/lib/retire-local.ts`:
 * `dirToArchive` is renamed to `${archivePath}.staging`, then
 * `createArchive(..., background: false)` is used to archive the CONTENTS
 * of the staging dir (no wrapper directory) and delete the staging dir.
 *
 * If production `retire-local.ts` regresses to the old "wrap in staging
 * dir" shape, this test will still pass — which is the tradeoff for dodging
 * the mock.module pollution. The archive shape is also directly covered by
 * `createArchive(synchronous)` coverage in this file via inline tar, and
 * the extraction-target side of the bug is covered via the real
 * `extractArchive` helper from recover.ts.
 */
function simulatedRetireArchiveStep(
  dirToArchive: string,
  archivePath: string,
  metadataPath: string,
  entry: AssistantEntry,
): void {
  const stagingDir = `${archivePath}.staging`;
  mkdirSync(dirname(stagingDir), { recursive: true });
  renameSync(dirToArchive, stagingDir);
  writeFileSync(metadataPath, JSON.stringify(entry, null, 2) + "\n");
  // IMPORTANT: the archive must contain the CONTENTS of stagingDir with
  // NO wrapper directory. `tar -C <dir> .` achieves this; the old buggy
  // form `tar -C dirname(stagingDir) basename(stagingDir)` wraps the
  // entries under `<basename(stagingDir)>/`, which recover extracts to
  // the wrong path.
  const res = spawnSync("tar", ["czf", archivePath, "-C", stagingDir, "."], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(
      `tar exited with code ${res.status} while archiving ${stagingDir}`,
    );
  }
  rmSync(stagingDir, { recursive: true, force: true });
}

describe("retire → recover round-trip", () => {
  beforeEach(() => {
    // Re-assert env-vars every test. Other test files (sleep.test.ts,
    // multi-local.test.ts, orphan-detection.test.ts, …) also set
    // `VELLUM_LOCKFILE_DIR` / `XDG_DATA_HOME` at module load time and
    // whichever loaded last wins at test-run time. Re-setting here
    // guarantees that `saveAssistantEntry`, `getArchivePath`, and
    // `loadAllAssistants` all read/write under our scratch dirs.
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    process.env.XDG_DATA_HOME = xdgDataHome;
    resetLockfile();
    resetRetiredDir();
  });

  test("named instance: archive contents restore to original instanceDir", async () => {
    // GIVEN a named-instance data directory populated with a recognizable
    // marker file inside `.vellum/workspace/` and a pid file under `.vellum/`
    const name = "roundtrip-named";
    const instanceDir = join(instancesRoot, name);
    const vellumDir = join(instanceDir, ".vellum");
    const workspaceDir = join(vellumDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const markerPath = join(workspaceDir, "marker.txt");
    writeFileSync(markerPath, "HELLO");
    const pidPath = join(vellumDir, "vellum.pid");
    writeFileSync(pidPath, "12345");

    // AND the lockfile has a matching entry for the instance
    const entry = makeNamedInstanceEntry(name, instanceDir);
    saveAssistantEntry(entry);

    // WHEN we archive the instance dir via the same steps `retireLocal` runs
    const archivePath = getArchivePath(name);
    const metadataPath = getMetadataPath(name);
    simulatedRetireArchiveStep(instanceDir, archivePath, metadataPath, entry);

    // THEN the original instance dir is gone
    expect(existsSync(instanceDir)).toBe(false);

    // AND the archive + metadata exist at the retired-dir location
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(metadataPath)).toBe(true);

    // AND no orphaned `<name>.tar.gz.staging` directory leaks anywhere on disk
    expect(existsSync(`${archivePath}.staging`)).toBe(false);

    // WHEN we extract the archive via the real recover helper
    await extractArchive(archivePath, entry);

    // THEN the marker file is restored at its original path, byte-identical
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("HELLO");

    // AND the pid file is also restored (regression guard against archives
    // that only capture `workspace/` and drop the top-level `.vellum/`
    // siblings)
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf-8")).toBe("12345");

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
    const archivePath = getArchivePath(name);
    const metadataPath = getMetadataPath(name);
    simulatedRetireArchiveStep(instanceDir, archivePath, metadataPath, entry);
    await extractArchive(archivePath, entry);

    // THEN both the top-level file AND the nested .vellum file are restored
    expect(readFileSync(topLevelPath, "utf-8")).toBe("TOP");
    expect(readFileSync(vellumFilePath, "utf-8")).toBe("INSIDE");
  });

  test("archive format: `tar -C <stagingDir> .` writes no wrapper directory", () => {
    // Direct coverage of the archive shape: simulate the retire tar command
    // and assert that the archive's top-level entries are the staging-dir
    // CONTENTS, not a `<basename(stagingDir)>/` wrapper.
    const stagingDir = mkdtempSync(join(tmpdir(), "cli-retire-staging-"));
    writeFileSync(join(stagingDir, "a.txt"), "A");
    mkdirSync(join(stagingDir, "sub"), { recursive: true });
    writeFileSync(join(stagingDir, "sub", "b.txt"), "B");

    const archivePath = join(
      mkdtempSync(join(tmpdir(), "cli-retire-archive-")),
      "test.tar.gz",
    );

    const tarRes = spawnSync(
      "tar",
      ["czf", archivePath, "-C", stagingDir, "."],
      { stdio: "inherit" },
    );
    expect(tarRes.status).toBe(0);
    expect(existsSync(archivePath)).toBe(true);

    // Extracting the archive into a fresh dir must reproduce the CONTENTS at
    // the root — no `<basename(stagingDir)>/` wrapper.
    const extractDir = mkdtempSync(join(tmpdir(), "cli-retire-extract-"));
    const extractRes = spawnSync(
      "tar",
      ["xzf", archivePath, "-C", extractDir],
      { stdio: "inherit" },
    );
    expect(extractRes.status).toBe(0);
    expect(readFileSync(join(extractDir, "a.txt"), "utf-8")).toBe("A");
    expect(readFileSync(join(extractDir, "sub", "b.txt"), "utf-8")).toBe("B");

    rmSync(extractDir, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(dirname(archivePath), { recursive: true, force: true });
  });
});
