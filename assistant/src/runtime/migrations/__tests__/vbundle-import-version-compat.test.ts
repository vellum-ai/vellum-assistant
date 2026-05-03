/**
 * Buffer importer runtime-version compat gate.
 *
 * Wires `commitImport` to `policy.evaluateRuntimeCompatibility` BEFORE any
 * state mutation. The platform-side gate is the primary check; this catches
 * legacy bundles whose ExportJob row predates PR #5470 (compat columns NULL
 * → platform gate skipped) and any caller that bypasses the platform-issued
 * signed URL flow.
 *
 * Invariants pinned here:
 *   - A compatible bundle imports normally.
 *   - An incompatible bundle (min_runtime_version above APP_VERSION) returns
 *     `{ ok: false, reason: "version_incompatible", bundle_compat,
 *     runtime_version }` with NO disk mutation.
 *   - The legacy sentinel "0.0.0-legacy" passes the gate unconditionally.
 *   - Pre-existing workspace files are byte-identical and no `*.backup-*`
 *     files are created when the gate rejects.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { APP_VERSION } from "../../../version.js";
import { buildVBundle } from "../vbundle-builder.js";
import { DefaultPathResolver } from "../vbundle-import-analyzer.js";
import { commitImport } from "../vbundle-importer.js";
import { defaultV1Options } from "./v1-test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshWorkspace(): string {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "vbundle-import-version-compat-")),
  );
  return join(parent, "workspace");
}

function cleanupWorkspaceParent(workspaceDir: string): void {
  try {
    rmSync(join(workspaceDir, ".."), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Recursively yields every regular file under `root` as a relative path. */
function* walkFiles(root: string): Generator<string> {
  if (!existsSync(root)) return;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) yield relative(root, abs);
    }
  }
}

function buildBundleWithMinRuntimeVersion(
  minRuntimeVersion: string,
): Uint8Array {
  const dbBytes = new TextEncoder().encode("db-payload");
  const configJson = JSON.stringify({ version: 1 });
  const { archive } = buildVBundle({
    files: [
      { path: "workspace/data/db/assistant.db", data: dbBytes },
      {
        path: "workspace/config.json",
        data: new TextEncoder().encode(configJson),
      },
    ],
    ...defaultV1Options(),
    compatibility: {
      min_runtime_version: minRuntimeVersion,
      max_runtime_version: null,
    },
  });
  return archive;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("commitImport runtime-version compat gate", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = freshWorkspace();
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    cleanupWorkspaceParent(workspaceDir);
  });

  test("compatible bundle imports normally", () => {
    const archive = buildBundleWithMinRuntimeVersion("0.0.1");

    const result = commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(workspaceDir, "data/db/assistant.db"))).toBe(true);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(true);
  });

  test("incompatible bundle (above APP_VERSION) returns version_incompatible without writing", () => {
    const archive = buildBundleWithMinRuntimeVersion("99.0.0");

    const result = commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "version_incompatible") {
      expect(result.bundle_compat.min_runtime_version).toBe("99.0.0");
      expect(result.bundle_compat.max_runtime_version).toBeNull();
      expect(result.runtime_version).toBe(APP_VERSION);
    } else {
      throw new Error(
        `expected version_incompatible, got ${JSON.stringify(result)}`,
      );
    }

    // Fresh workspace stays empty — no bundle files, no backups.
    expect([...walkFiles(workspaceDir)]).toEqual([]);
  });

  test("legacy sentinel passes through", () => {
    const archive = buildBundleWithMinRuntimeVersion("0.0.0-legacy");

    const result = commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(workspaceDir, "data/db/assistant.db"))).toBe(true);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(true);
  });

  test("pre-existing workspace files stay untouched on incompatibility", () => {
    const sentinelPath = join(workspaceDir, "sentinel.txt");
    const sentinelContent = "keep me";
    writeFileSync(sentinelPath, sentinelContent);

    const archive = buildBundleWithMinRuntimeVersion("99.0.0");

    const result = commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("version_incompatible");

    expect(readFileSync(sentinelPath, "utf-8")).toBe(sentinelContent);
    // Only the seeded sentinel remains — no bundle files, no `*.backup-*`.
    expect([...walkFiles(workspaceDir)]).toEqual(["sentinel.txt"]);
  });
});
