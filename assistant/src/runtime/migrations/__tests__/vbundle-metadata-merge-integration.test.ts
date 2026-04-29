/**
 * Integration tests confirming both importers preserve the target's
 * `vellum:*` credential metadata entries across a bundle import.
 *
 * Covers:
 * - Buffer-based `commitImport`: target has all 4 vellum entries, bundle
 *   carries non-vellum user entries → target retains its vellum entries
 *   and gains the bundle's user entries.
 * - Streaming `streamCommitImport`: same scenario via the atomic-swap
 *   path.
 * - Bundle with rogue vellum entries → filtered out on both paths.
 * - Bundle without a metadata.json entry → target's preserved entries are
 *   restored on the buffer path.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildVBundle } from "../vbundle-builder.js";
import { DefaultPathResolver } from "../vbundle-import-analyzer.js";
import { commitImport } from "../vbundle-importer.js";
import { streamCommitImport } from "../vbundle-streaming-importer.js";
import { defaultV1Options } from "./v1-test-helpers.js";

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

interface Record {
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  createdAt: number;
  updatedAt: number;
}

const VELLUM_FIELDS = [
  "platform_base_url",
  "assistant_api_key",
  "platform_assistant_id",
  "webhook_secret",
] as const;

function record(service: string, field: string, prefix = "id"): Record {
  const now = Date.now();
  return {
    credentialId: `${prefix}-${service}-${field}`,
    service,
    field,
    allowedTools: [],
    allowedDomains: [],
    createdAt: now,
    updatedAt: now,
  };
}

function metadataJson(records: Record[]): string {
  return JSON.stringify({ version: 5, credentials: records });
}

function vellumRecords(prefix = "target"): Record[] {
  return VELLUM_FIELDS.map((field) => record("vellum", field, prefix));
}

function readMetadata(path: string): { credentials: Record[] } {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as { credentials: Record[] };
}

function keys(records: Record[]): Set<string> {
  return new Set(records.map((r) => `${r.service}:${r.field}`));
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function readableFrom(buf: Uint8Array): Readable {
  return Readable.from([Buffer.from(buf)]);
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function freshWorkspace(): string {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "vbundle-metadata-merge-")),
  );
  return join(parent, "workspace");
}

function seedTargetMetadata(workspaceDir: string, records: Record[]): string {
  const dir = join(workspaceDir, "data", "credentials");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "metadata.json");
  writeFileSync(path, metadataJson(records));
  return path;
}

// ---------------------------------------------------------------------------
// Buffer-based `commitImport` integration
// ---------------------------------------------------------------------------

describe("commitImport — credential metadata merge", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
    mkdirSync(workspaceDir, { recursive: true });
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("target vellum:* entries survive; bundle user entries land", () => {
    const metadataPath = seedTargetMetadata(workspaceDir, vellumRecords());

    const bundleMetadata = metadataJson([
      record("telegram", "bot_token", "source"),
      record("slack_channel", "app_token", "source"),
    ]);
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/data/credentials/metadata.json",
          data: encode(bundleMetadata),
        },
        // Include at least one other workspace entry so Step 1b fires.
        { path: "workspace/noop.txt", data: encode("noop") },
      ],
      ...defaultV1Options(),
    });

    const result = commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    const merged = readMetadata(metadataPath);
    const mergedKeys = keys(merged.credentials);
    for (const field of VELLUM_FIELDS) {
      expect(mergedKeys.has(`vellum:${field}`)).toBe(true);
    }
    expect(mergedKeys.has("telegram:bot_token")).toBe(true);
    expect(mergedKeys.has("slack_channel:app_token")).toBe(true);

    // Preserved vellum entries must carry target's credentialIds.
    for (const r of merged.credentials) {
      if (r.service === "vellum") {
        expect(r.credentialId.startsWith("target-")).toBe(true);
      }
    }
  });

  test("rogue vellum entries in the bundle are dropped", () => {
    const metadataPath = seedTargetMetadata(workspaceDir, vellumRecords());
    const bundleMetadata = metadataJson([
      record("vellum", "assistant_api_key", "source-rogue"),
      record("vellum", "platform_base_url", "source-rogue"),
      record("telegram", "bot_token", "source"),
    ]);
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/data/credentials/metadata.json",
          data: encode(bundleMetadata),
        },
        { path: "workspace/noop.txt", data: encode("noop") },
      ],
      ...defaultV1Options(),
    });

    const result = commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });
    expect(result.ok).toBe(true);

    const merged = readMetadata(metadataPath);
    const vellum = merged.credentials.filter((r) => r.service === "vellum");
    expect(vellum.length).toBe(4);
    for (const r of vellum) {
      expect(r.credentialId.startsWith("target-")).toBe(true);
    }
    expect(keys(merged.credentials).has("telegram:bot_token")).toBe(true);
  });

  test("bundle without metadata.json still leaves target's vellum entries on disk", () => {
    const metadataPath = seedTargetMetadata(workspaceDir, vellumRecords());

    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: new Uint8Array() },
        { path: "workspace/noop.txt", data: encode("noop") },
      ],
      ...defaultV1Options(),
    });

    const result = commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });
    expect(result.ok).toBe(true);

    expect(existsSync(metadataPath)).toBe(true);
    const merged = readMetadata(metadataPath);
    const mergedKeys = keys(merged.credentials);
    for (const field of VELLUM_FIELDS) {
      expect(mergedKeys.has(`vellum:${field}`)).toBe(true);
    }
  });

  test("target without existing metadata.json → bundle's file lands verbatim", () => {
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/data/credentials/metadata.json",
          data: encode(
            metadataJson([record("telegram", "bot_token", "source")]),
          ),
        },
        { path: "workspace/noop.txt", data: encode("noop") },
      ],
      ...defaultV1Options(),
    });

    const result = commitImport({
      archiveData: archive,
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });
    expect(result.ok).toBe(true);

    const merged = readMetadata(
      join(workspaceDir, "data", "credentials", "metadata.json"),
    );
    expect(keys(merged.credentials)).toEqual(new Set(["telegram:bot_token"]));
  });
});

// ---------------------------------------------------------------------------
// Streaming importer integration
// ---------------------------------------------------------------------------

describe("streamCommitImport — credential metadata merge", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = freshWorkspace();
    mkdirSync(workspaceDir, { recursive: true });
  });
  afterEach(() => {
    const parent = join(workspaceDir, "..");
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("target vellum:* entries survive atomic swap; bundle user entries land", async () => {
    const metadataPath = seedTargetMetadata(workspaceDir, vellumRecords());

    const bundleMetadata = metadataJson([
      record("telegram", "bot_token", "source"),
    ]);
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/data/credentials/metadata.json",
          data: encode(bundleMetadata),
        },
        { path: "workspace/noop.txt", data: encode("noop") },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });

    expect(result.ok).toBe(true);

    const merged = readMetadata(metadataPath);
    const mergedKeys = keys(merged.credentials);
    for (const field of VELLUM_FIELDS) {
      expect(mergedKeys.has(`vellum:${field}`)).toBe(true);
    }
    expect(mergedKeys.has("telegram:bot_token")).toBe(true);
    for (const r of merged.credentials) {
      if (r.service === "vellum") {
        expect(r.credentialId.startsWith("target-")).toBe(true);
      }
    }
  });

  test("rogue vellum entries in bundle are dropped on streaming path", async () => {
    const metadataPath = seedTargetMetadata(workspaceDir, vellumRecords());
    const bundleMetadata = metadataJson([
      record("vellum", "assistant_api_key", "source-rogue"),
      record("telegram", "bot_token", "source"),
    ]);
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/data/credentials/metadata.json",
          data: encode(bundleMetadata),
        },
        { path: "workspace/noop.txt", data: encode("noop") },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });
    expect(result.ok).toBe(true);

    const merged = readMetadata(metadataPath);
    for (const r of merged.credentials) {
      if (r.service === "vellum") {
        expect(r.credentialId.startsWith("target-")).toBe(true);
      }
    }
    expect(keys(merged.credentials).has("telegram:bot_token")).toBe(true);
  });

  test("bundle without metadata.json keeps target's vellum entries after swap", async () => {
    const metadataPath = seedTargetMetadata(workspaceDir, vellumRecords());

    const { archive } = buildVBundle({
      files: [
        { path: "data/db/assistant.db", data: new Uint8Array() },
        { path: "workspace/noop.txt", data: encode("noop") },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });
    expect(result.ok).toBe(true);

    expect(existsSync(metadataPath)).toBe(true);
    const merged = readMetadata(metadataPath);
    const mergedKeys = keys(merged.credentials);
    for (const field of VELLUM_FIELDS) {
      expect(mergedKeys.has(`vellum:${field}`)).toBe(true);
    }
  });

  test("target with no metadata.json → bundle's file lands on disk verbatim", async () => {
    const { archive } = buildVBundle({
      files: [
        {
          path: "data/db/assistant.db",
          data: new Uint8Array(),
        },
        {
          path: "workspace/data/credentials/metadata.json",
          data: encode(
            metadataJson([record("telegram", "bot_token", "source")]),
          ),
        },
        { path: "workspace/noop.txt", data: encode("noop") },
      ],
      ...defaultV1Options(),
    });

    const result = await streamCommitImport({
      source: readableFrom(archive),
      pathResolver: new DefaultPathResolver(workspaceDir),
      workspaceDir,
    });
    expect(result.ok).toBe(true);

    const merged = readMetadata(
      join(workspaceDir, "data", "credentials", "metadata.json"),
    );
    expect(keys(merged.credentials)).toEqual(new Set(["telegram:bot_token"]));
  });
});
