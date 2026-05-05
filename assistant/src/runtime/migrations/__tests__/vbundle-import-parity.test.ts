/**
 * Buffer-vs-streaming `.vbundle` import parity suite.
 *
 * Pins the existing disk-outcome equivalence between `commitImport`
 * (buffer-based) and `streamCommitImport` (streaming) as a regression net
 * BEFORE any production code is migrated to a shared policy module.
 *
 * Each test builds one archive, mkdtemps two sibling workspaces, seeds them
 * identically, runs each importer against its own workspace, and asserts the
 * post-import disk trees are byte-for-byte identical:
 *
 *   expect(walkDiskTree(streamWs)).toEqual(walkDiskTree(bufferWs))
 *
 * Per-case invariants (carry-forward markers survive, persona lands at the
 * right disk path, traversal entries do not erase the workspace, etc.) are
 * asserted on top of disk-tree equality.
 */

import { createHash } from "node:crypto";
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
import { dirname, join, relative } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import { DefaultPathResolver } from "../vbundle-import-analyzer.js";
import { commitImport } from "../vbundle-importer.js";
import { streamCommitImport } from "../vbundle-streaming-importer.js";
import { defaultV1Options } from "./v1-test-helpers.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Allocate a fresh workspace path under a temp parent dir we own. The parent
 * is realpath-resolved so macOS `/var` → `/private/var` symlink mismatches
 * don't trip the streaming importer's `rebaseOntoTempWorkspace` containment
 * check (which compares `resolve(diskPath)` against `resolve(workspaceDir)`).
 *
 * Returns `<parent>/workspace`. The directory itself is NOT created — tests
 * that need it pre-existing call `mkdirSync` themselves.
 */
function freshWorkspace(): string {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "vbundle-import-parity-")),
  );
  return join(parent, "workspace");
}

/** Best-effort cleanup of a workspace's parent dir. */
function cleanupWorkspaceParent(workspaceDir: string): void {
  try {
    rmSync(join(workspaceDir, ".."), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Recursively walk `root` and return a `Map<relPath, sha256Hex>` for every
 * regular file. Skips dot-prefixed scratch dirs the streaming importer may
 * leave behind on failure paths (`.import-*`, `.pre-import-*`) plus the
 * import marker file — the buffer importer never produces these, so they'd
 * spuriously break parity if included.
 *
 * Two importers are parity-equivalent for a given input iff the maps they
 * produce on identically-seeded sibling workspaces are equal.
 */
function walkDiskTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;

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
      // Skip streaming-importer scratch artifacts so they don't show up as
      // false negatives in the parity comparison.
      if (
        entry.name.startsWith(".import-") ||
        entry.name.startsWith(".pre-import-") ||
        entry.name === ".import-marker.json"
      ) {
        continue;
      }
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        const rel = relative(root, abs);
        out.set(rel, sha256Hex(readFileSync(abs)));
      }
    }
  }
  return out;
}

interface SeedFile {
  relPath: string;
  content: string | Uint8Array;
}

/** Mkdir parents and write each file to `workspaceDir`. */
function seedLiveWorkspace(workspaceDir: string, files: SeedFile[]): void {
  mkdirSync(workspaceDir, { recursive: true });
  for (const { relPath, content } of files) {
    const abs = join(workspaceDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function runBufferImport(workspaceDir: string, archive: Uint8Array): void {
  const result = commitImport({
    archiveData: archive,
    pathResolver: new DefaultPathResolver(workspaceDir),
    workspaceDir,
  });
  if (!result.ok) {
    throw new Error(
      `buffer commitImport unexpectedly failed: ${JSON.stringify(result)}`,
    );
  }
}

async function runStreamImport(
  workspaceDir: string,
  archive: Uint8Array,
  importCredentials?: (
    credentials: Array<{ account: string; value: string }>,
  ) => Promise<void>,
): Promise<void> {
  const result = await streamCommitImport({
    source: Readable.from([Buffer.from(archive)]),
    pathResolver: new DefaultPathResolver(workspaceDir),
    workspaceDir,
    importCredentials,
  });
  if (!result.ok) {
    throw new Error(
      `streamCommitImport unexpectedly failed: ${JSON.stringify(result)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe("vbundle import parity (buffer vs streaming)", () => {
  let bufferWs: string;
  let streamWs: string;

  beforeEach(() => {
    bufferWs = freshWorkspace();
    streamWs = freshWorkspace();
  });

  afterEach(() => {
    cleanupWorkspaceParent(bufferWs);
    cleanupWorkspaceParent(streamWs);
  });

  test("A — full workspace + credentials: identical disk outcome", async () => {
    const dbBytes = new Uint8Array(16);
    for (let i = 0; i < dbBytes.length; i++) dbBytes[i] = (i * 17) & 0xff;

    const configJson = JSON.stringify({ version: 1 });
    const metadataJson = JSON.stringify({
      version: 5,
      credentials: [
        {
          credentialId: "id-openai-api_key",
          service: "openai",
          field: "api_key",
          allowedTools: [],
          allowedDomains: [],
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      ],
    });

    const openaiKey = new Uint8Array(16);
    for (let i = 0; i < openaiKey.length; i++) openaiKey[i] = (i + 5) & 0xff;
    const anthropicKey = new TextEncoder().encode("sk-ant-test");

    const { archive } = buildVBundle({
      files: [
        { path: "workspace/data/db/assistant.db", data: dbBytes },
        {
          path: "workspace/config.json",
          data: new TextEncoder().encode(configJson),
        },
        {
          path: "workspace/data/credentials/metadata.json",
          data: new TextEncoder().encode(metadataJson),
        },
        { path: "credentials/openai-key", data: openaiKey },
        { path: "credentials/anthropic-key", data: anthropicKey },
      ],
      ...defaultV1Options(),
    });

    // Pre-create both workspaces (streaming importer expects to operate
    // against an existing dir and the atomic-swap path requires it).
    mkdirSync(bufferWs, { recursive: true });
    mkdirSync(streamWs, { recursive: true });

    runBufferImport(bufferWs, archive);
    await runStreamImport(streamWs, archive, async () => {
      // parity test: credentials are intercepted but not persisted
    });

    const bufferMap = walkDiskTree(bufferWs);
    const streamMap = walkDiskTree(streamWs);

    expect(streamMap).toEqual(bufferMap);

    // Sanity: the three workspace-bound files we expect both importers to
    // land are present in the parity map.
    expect(bufferMap.has("data/db/assistant.db")).toBe(true);
    expect(bufferMap.has("config.json")).toBe(true);
    expect(bufferMap.has("data/credentials/metadata.json")).toBe(true);
  });

  test("B — config-only partial bundle: live preserved paths survive on both sides", async () => {
    const seeds: SeedFile[] = [
      { relPath: "data/db/marker", content: "db-marker" },
      { relPath: "data/qdrant/marker", content: "qdrant-marker" },
      { relPath: "embedding-models/marker", content: "embedding-marker" },
      { relPath: "deprecated/marker", content: "deprecated-marker" },
    ];

    seedLiveWorkspace(bufferWs, seeds);
    seedLiveWorkspace(streamWs, seeds);

    const configJson = JSON.stringify({ version: 1 });
    const { archive } = buildVBundle({
      files: [
        // Validator requires the DB entry (legacy or workspace-prefixed).
        // It's not the focus of this case — config.json is — but it must
        // be present for the bundle to validate.
        { path: "data/db/assistant.db", data: new Uint8Array() },
        {
          path: "workspace/config.json",
          data: new TextEncoder().encode(configJson),
        },
      ],
      ...defaultV1Options(),
    });

    runBufferImport(bufferWs, archive);
    await runStreamImport(streamWs, archive);

    const bufferMap = walkDiskTree(bufferWs);
    const streamMap = walkDiskTree(streamWs);

    expect(streamMap).toEqual(bufferMap);

    // Each carry-forward marker must still be on disk.
    for (const seed of seeds) {
      expect(bufferMap.has(seed.relPath)).toBe(true);
      expect(streamMap.has(seed.relPath)).toBe(true);
    }
  });

  test("C — legacy prompts/USER.md: both importers land it at users/<slug>.md", async () => {
    const personaBody = `_ Lines starting with _ are comments - they won't appear in the system prompt

# User Profile

- Preferred name/reference: Captain Parity
- Pronouns: they/them
- Locale: en-US
- Work role: Quartermaster
- Goals: Verify importer parity
- Hobbies/fun: Diff'ing trees
- Daily tools: Terminal
`;

    // Pre-create users/ in both workspaces so the resolver's containment
    // check has a real on-disk parent to anchor against.
    mkdirSync(join(bufferWs, "users"), { recursive: true });
    mkdirSync(join(streamWs, "users"), { recursive: true });

    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: new Uint8Array() },
        {
          path: "prompts/USER.md",
          data: new TextEncoder().encode(personaBody),
        },
      ],
      ...defaultV1Options(),
    });

    const bufferGuardianPath = join(bufferWs, "users", "captain.md");
    const streamGuardianPath = join(streamWs, "users", "captain.md");

    const bufferResolver = new DefaultPathResolver(
      bufferWs,
      undefined,
      () => bufferGuardianPath,
    );
    const streamResolver = new DefaultPathResolver(
      streamWs,
      undefined,
      () => streamGuardianPath,
    );

    const bufferResult = commitImport({
      archiveData: archive,
      pathResolver: bufferResolver,
      workspaceDir: bufferWs,
    });
    expect(bufferResult.ok).toBe(true);

    const streamResult = await streamCommitImport({
      source: Readable.from([Buffer.from(archive)]),
      pathResolver: streamResolver,
      workspaceDir: streamWs,
    });
    expect(streamResult.ok).toBe(true);

    const bufferMap = walkDiskTree(bufferWs);
    const streamMap = walkDiskTree(streamWs);

    expect(streamMap).toEqual(bufferMap);

    expect(existsSync(bufferGuardianPath)).toBe(true);
    expect(existsSync(streamGuardianPath)).toBe(true);
    expect(readFileSync(bufferGuardianPath, "utf-8")).toBe(personaBody);
    expect(readFileSync(streamGuardianPath, "utf-8")).toBe(personaBody);
  });

  test("D — no workspace entries at all: legacy bundle leaves seeded files in place", async () => {
    const seeds: SeedFile[] = [
      { relPath: "unrelated.txt", content: "stay" },
      { relPath: "custom-dir/note.md", content: "# note" },
    ];

    seedLiveWorkspace(bufferWs, seeds);
    seedLiveWorkspace(streamWs, seeds);

    const dbBytes = new TextEncoder().encode("legacy-db-payload");
    const { archive } = buildVBundle({
      files: [{ path: "data/db/assistant.db", data: dbBytes }],
      ...defaultV1Options(),
    });

    runBufferImport(bufferWs, archive);
    await runStreamImport(streamWs, archive);

    const bufferMap = walkDiskTree(bufferWs);
    const streamMap = walkDiskTree(streamWs);

    expect(streamMap).toEqual(bufferMap);

    for (const seed of seeds) {
      expect(bufferMap.has(seed.relPath)).toBe(true);
      expect(streamMap.has(seed.relPath)).toBe(true);
    }
  });

  test("E — path-traversal workspace entry: both importers refuse to clear", async () => {
    seedLiveWorkspace(bufferWs, [{ relPath: "marker.txt", content: "keep" }]);
    seedLiveWorkspace(streamWs, [{ relPath: "marker.txt", content: "keep" }]);

    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: new Uint8Array() },
        {
          path: "workspace/../../etc/passwd",
          data: new TextEncoder().encode("nope"),
        },
      ],
      ...defaultV1Options(),
    });

    runBufferImport(bufferWs, archive);
    await runStreamImport(streamWs, archive);

    const bufferMap = walkDiskTree(bufferWs);
    const streamMap = walkDiskTree(streamWs);

    expect(streamMap).toEqual(bufferMap);

    expect(bufferMap.has("marker.txt")).toBe(true);
    expect(streamMap.has("marker.txt")).toBe(true);
  });
});
