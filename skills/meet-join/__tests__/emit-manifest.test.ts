/**
 * Tests for `skills/meet-join/scripts/emit-manifest.ts`.
 *
 * The emit-manifest script is the build-time artifact producer the
 * manifest-loading daemon path (PR 28) reads to register proxy tools
 * without importing the skill in-process. If the script's JSON shape,
 * tool coverage, or source-hash determinism drifts, the daemon's
 * lazy-external meet-host flow silently breaks — so this test guards
 * the contract explicitly.
 *
 * The script is invoked as a subprocess (rather than imported) so the
 * test exercises the real `bun run` entry point, including its
 * `process.argv` parsing and exit behavior.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(scriptDir, "..");
const repoRoot = resolve(skillRoot, "..", "..");
const scriptPath = join(skillRoot, "scripts", "emit-manifest.ts");

const EXPECTED_TOOL_NAMES = [
  "meet_cancel_speak",
  "meet_disable_avatar",
  "meet_enable_avatar",
  "meet_join",
  "meet_leave",
  "meet_send_chat",
  "meet_speak",
];

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "emit-manifest-test-"));
  tempDirs.push(dir);
  return dir;
}

interface EmitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  manifest: unknown;
}

function runEmit(outputPath: string): EmitResult {
  const result = spawnSync("bun", ["run", scriptPath, "--output", outputPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const manifest =
    result.status === 0 ? JSON.parse(readFileSync(outputPath, "utf8")) : null;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    manifest,
  };
}

describe("emit-manifest", () => {
  test("produces a well-formed JSON manifest at the --output path", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, "manifest.json");
    const result = runEmit(outputPath);

    if (result.status !== 0) {
      throw new Error(
        `emit-manifest exited with status ${result.status}:\n${result.stderr}`,
      );
    }

    const manifest = result.manifest as Record<string, unknown>;
    expect(manifest).toBeTypeOf("object");
    expect(manifest).not.toBeNull();
    expect(manifest.skill).toBe("meet-join");
    expect(Array.isArray(manifest.tools)).toBe(true);
    expect(Array.isArray(manifest.routes)).toBe(true);
    expect(Array.isArray(manifest.shutdownHooks)).toBe(true);
    expect(manifest.sourceHash).toBeTypeOf("string");
    // SHA-256 hex is 64 characters.
    expect((manifest.sourceHash as string).length).toBe(64);
  });

  test("tool count and names match register.ts", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, "manifest.json");
    const result = runEmit(outputPath);

    if (result.status !== 0) {
      throw new Error(
        `emit-manifest exited with status ${result.status}:\n${result.stderr}`,
      );
    }

    const manifest = result.manifest as {
      tools: Array<Record<string, unknown>>;
    };
    expect(manifest.tools.length).toBe(EXPECTED_TOOL_NAMES.length);

    const manifestNames = manifest.tools.map((t) => t.name as string).sort();
    expect(manifestNames).toEqual([...EXPECTED_TOOL_NAMES].sort());

    // Each tool entry must carry the manifest-facing fields the
    // daemon loader (PR 28) reads. Missing a field here would leave
    // the proxy tool with an undefined property at registration time.
    for (const tool of manifest.tools) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.description).toBeTypeOf("string");
      expect(tool.category).toBeTypeOf("string");
      expect(tool.risk).toBeTypeOf("string");
      expect(tool.input_schema).toBeTypeOf("object");
    }
  });

  test("source hash is stable across runs (deterministic output)", () => {
    const firstDir = makeTempDir();
    const secondDir = makeTempDir();
    const firstPath = join(firstDir, "manifest.json");
    const secondPath = join(secondDir, "manifest.json");

    const first = runEmit(firstPath);
    const second = runEmit(secondPath);

    if (first.status !== 0 || second.status !== 0) {
      throw new Error(
        `emit-manifest failed:\nfirst: ${first.stderr}\nsecond: ${second.stderr}`,
      );
    }

    const firstHash = (first.manifest as { sourceHash: string }).sourceHash;
    const secondHash = (second.manifest as { sourceHash: string }).sourceHash;
    expect(secondHash).toBe(firstHash);

    // The full manifest bytes must also be identical — sort order and
    // field ordering are part of the deterministic contract, so CI can
    // fail-fast on an unintentional diff without re-hashing.
    const firstBytes = readFileSync(firstPath, "utf8");
    const secondBytes = readFileSync(secondPath, "utf8");
    expect(secondBytes).toBe(firstBytes);
  });
});
