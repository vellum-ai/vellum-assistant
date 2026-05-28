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

  test("attaches a run function discovered at benchmarks/<id>/src/run.ts", async () => {
    // The benchmark module's run.ts is resolved relative to the
    // evals source tree (NOT EVALS_BENCHMARKS_DIR — the env var only
    // controls manifest + unit data layout). We verify the wiring
    // for the two real benchmarks; the test asserts the contract
    // (typeof === "function") rather than calling run() since that
    // would require a full hatched profile.
    const dir = await mkdtemp(join(tmpdir(), "evals-benchmarks-"));
    process.env.EVALS_BENCHMARKS_DIR = dir;

    for (const id of ["longmemeval-v2", "personal-intelligence"]) {
      const unitDirName = id === "longmemeval-v2" ? "items" : "tests";
      const unitNoun = id === "longmemeval-v2" ? "item" : "test";
      await mkdir(join(dir, id, unitDirName), { recursive: true });
      await writeFile(
        join(dir, id, "manifest.json"),
        JSON.stringify({ displayName: id, unitDirName, unitNoun }),
        "utf8",
      );

      const benchmark = await loadBenchmark(id);
      expect(typeof benchmark.run).toBe("function");
    }
  });

  test("reports a missing run module with the expected convention path", async () => {
    // A benchmark id valid by the SAFE_ID regex and with a present
    // manifest, but no `src/run.ts` at the conventional location in
    // the evals source tree, must surface a clear, conventional
    // error pointing at the file the operator needs to create.
    const dir = await mkdtemp(join(tmpdir(), "evals-benchmarks-"));
    process.env.EVALS_BENCHMARKS_DIR = dir;
    await mkdir(join(dir, "ghost-benchmark", "items"), { recursive: true });
    await writeFile(
      join(dir, "ghost-benchmark", "manifest.json"),
      JSON.stringify({
        displayName: "Ghost",
        unitDirName: "items",
        unitNoun: "item",
      }),
      "utf8",
    );

    await expect(loadBenchmark("ghost-benchmark")).rejects.toThrow(
      /missing a run module at benchmarks\/ghost-benchmark\/src\/run\.ts/,
    );
  });

  test("rejects ids that escape the benchmarks directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-benchmarks-"));
    process.env.EVALS_BENCHMARKS_DIR = dir;

    await expect(loadBenchmark("bad_id")).rejects.toThrow(
      "Invalid benchmark id",
    );
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
    await writeFile(join(dir, "broken", "manifest.json"), "{not json", "utf8");

    await expect(loadBenchmark("broken")).rejects.toThrow(/is not valid JSON/);
  });
});
