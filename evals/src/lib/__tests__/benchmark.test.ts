import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { loadBenchmark } from "../benchmark";

const originalBenchmarksDir = process.env.EVALS_BENCHMARKS_DIR;

afterEach(() => {
  if (originalBenchmarksDir === undefined)
    delete process.env.EVALS_BENCHMARKS_DIR;
  else process.env.EVALS_BENCHMARKS_DIR = originalBenchmarksDir;
});

describe("loadBenchmark", () => {
  test("resolves manifest and units directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-benchmarks-"));
    process.env.EVALS_BENCHMARKS_DIR = dir;

    await mkdir(join(dir, "longmemeval-v2", "items"), { recursive: true });
    await writeFile(
      join(dir, "longmemeval-v2", "manifest.json"),
      JSON.stringify({
        displayName: "LongMemEval v2",
        unitDirName: "items",
        unitNoun: "item",
      }),
      "utf8",
    );

    const benchmark = await loadBenchmark("longmemeval-v2");
    expect(benchmark.id).toBe("longmemeval-v2");
    expect(benchmark.manifest).toMatchObject({
      displayName: "LongMemEval v2",
      unitDirName: "items",
      unitNoun: "item",
    });
    expect(benchmark.unitsDir).toBe(join(dir, "longmemeval-v2", "items"));
  });

  test("rejects ids that escape the benchmarks directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-benchmarks-"));
    process.env.EVALS_BENCHMARKS_DIR = dir;

    await expect(loadBenchmark("bad_id")).rejects.toThrow("Invalid benchmark id");
  });

  test("reports missing manifest with a helpful path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-benchmarks-"));
    process.env.EVALS_BENCHMARKS_DIR = dir;
    await mkdir(join(dir, "no-manifest"), { recursive: true });

    await expect(loadBenchmark("no-manifest")).rejects.toThrow(
      /Benchmark "no-manifest" not found/,
    );
  });

  test("reports schema-failed manifests with field-level issues", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-benchmarks-"));
    process.env.EVALS_BENCHMARKS_DIR = dir;
    await mkdir(join(dir, "bad-manifest"), { recursive: true });
    await writeFile(
      join(dir, "bad-manifest", "manifest.json"),
      JSON.stringify({ displayName: "", unitDirName: "Items!", unitNoun: "1" }),
      "utf8",
    );

    await expect(loadBenchmark("bad-manifest")).rejects.toThrow(
      /failed schema validation/,
    );
  });

  test("reports malformed JSON manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-benchmarks-"));
    process.env.EVALS_BENCHMARKS_DIR = dir;
    await mkdir(join(dir, "broken"), { recursive: true });
    await writeFile(
      join(dir, "broken", "manifest.json"),
      "{not json",
      "utf8",
    );

    await expect(loadBenchmark("broken")).rejects.toThrow(
      /is not valid JSON/,
    );
  });
});
