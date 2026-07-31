/**
 * Regression tests for the shared stdin reader.
 *
 * The bug these guard: reading stdin via `readFileSync("/dev/stdin")` fails
 * with `ENXIO: no such device or address` when the process is a child in a
 * shell pipeline (`producer | consumer`), because a pipe read-end cannot be
 * reopened by path. Reading file descriptor 0 directly works for pipes,
 * files, and empty/closed stdin alike.
 *
 * These exercise the real mechanism by spawning child processes that import
 * the helper and read genuinely piped / empty stdin — not a mocked fs.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const helperPath = join(import.meta.dir, "..", "read-stdin.ts");

let scratchDir: string;
let consumerPath: string;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "read-stdin-test-"));
  consumerPath = join(scratchDir, "consumer.ts");
  // A consumer that reads all of stdin via the shared helper and echoes it,
  // reporting any read error's code so the test can distinguish ENXIO.
  const consumer = [
    `import { readStdinSync } from ${JSON.stringify(helperPath)};`,
    `try {`,
    `  const data = readStdinSync();`,
    `  process.stdout.write("OK:" + data);`,
    `} catch (err) {`,
    `  const code = err && typeof err === "object" && "code" in err ? String(err.code) : String(err);`,
    `  process.stdout.write("ERR:" + code);`,
    `  process.exitCode = 1;`,
    `}`,
  ].join("\n");
  writeFileSync(consumerPath, consumer, "utf-8");
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("readStdinSync", () => {
  test("reads piped input from a shell pipeline without ENXIO", () => {
    const payload = '{"scores":[98,85,72]}';
    // `producer | consumer` — the consumer's stdin is a real pipe read-end,
    // the exact shape that broke `open("/dev/stdin")`.
    const result = spawnSync(
      "bash",
      [
        "-c",
        `printf '%s' ${JSON.stringify(payload)} | ${JSON.stringify(process.execPath)} run ${JSON.stringify(consumerPath)}`,
      ],
      { encoding: "utf-8" },
    );

    expect(result.stdout).toBe(`OK:${payload}`);
    expect(result.status).toBe(0);
  });

  test("returns empty string for ignored (EOF) stdin without ENXIO", () => {
    // Mirrors the shell tool's spawn wiring (`stdio: ["ignore", ...]`), which
    // attaches /dev/null: reading fd 0 yields immediate EOF, never ENXIO.
    const result = spawnSync(process.execPath, ["run", consumerPath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.stdout).toBe("OK:");
    expect(result.status).toBe(0);
  });

  test("in-process read of fd 0 does not reopen /dev/stdin", () => {
    // A closed/absent fd 0 would surface a read error, but never the
    // path-reopen ENXIO that reintroducing "/dev/stdin" would cause.
    const result = spawnSync(
      "bash",
      [
        "-c",
        `printf '%s' hello | ${JSON.stringify(process.execPath)} run ${JSON.stringify(consumerPath)}`,
      ],
      { encoding: "utf-8" },
    );

    expect(result.stdout).not.toContain("ENXIO");
    expect(result.stdout).toBe("OK:hello");
  });
});
