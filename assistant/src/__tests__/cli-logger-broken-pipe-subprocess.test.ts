/**
 * End-to-end regression for the CLI logger writing into a pipe whose reader
 * has exited.
 *
 * The in-process tests in `cli-logger-closed-output.test.ts` drive `cliWrite`
 * with stream stubs. They cannot prove the containment against the real
 * failure, because the real failure is asynchronous and runtime-specific: a
 * broken-pipe write is not raised at the call site, it is handed to the write
 * completion callback on a later tick, and with no callback it escalates to an
 * `uncaughtException`. Whether an `error` event is *also* emitted on the stream
 * (Node's `errorOrDestroy` path) decides whether the callback alone is
 * sufficient, and that is not something a stub can answer.
 *
 * So this spawns a real child that imports the real `getCliLogger`, pipes its
 * stdout into `head -1`, and lets the reader exit. Every write after that hits
 * a pipe with no reader. The child reports its own outcome on stderr, which
 * bypasses the pipeline.
 *
 * This is the shape that took the daemon down: it is spawned detached with
 * `stdio: ["ignore", "pipe", "pipe"]` and outlives the parent holding the read
 * end. It is also plain `assistant … | head`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const loggerPath = join(import.meta.dir, "..", "util", "logger.ts");

const ROUNDS = 6;
const PER_ROUND = 100;
const TOTAL_LINES = ROUNDS * PER_ROUND;

let scratchDir: string;
let childPath: string;

/**
 * Writes in rounds, yielding between them. The yield matters twice: it gives
 * `head` time to exit and close the read end, and it lets deferred write
 * callbacks fire, which is the tick on which an unhandled failure would
 * escalate.
 */
const CHILD_SOURCE = `
import { getCliLogger } from ${JSON.stringify(loggerPath)};

const log = getCliLogger("cli");

process.on("uncaughtException", (err) => {
  process.stderr.write("UNCAUGHT code=" + (err.code ?? "none") + " msg=" + err.message + "\\n");
  process.exit(17);
});

let written = 0;
for (let round = 0; round < ${ROUNDS}; round++) {
  for (let i = 0; i < ${PER_ROUND}; i++) {
    log.info("row " + ++written);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

process.stderr.write("SURVIVED lines=" + written + "\\n");
process.exit(0);
`;

/** Run the child with its stdout piped into `head -1`, and report the child's own exit status. */
function runAgainstClosedReader(): { status: number | null; stderr: string } {
  const command =
    JSON.stringify(process.execPath) +
    " run " +
    JSON.stringify(childPath) +
    " | head -1; exit ${PIPESTATUS[0]}";
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf-8",
    env: { ...process.env, VELLUM_WORKSPACE_DIR: scratchDir },
  });
  return { status: result.status, stderr: result.stderr };
}

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "cli-logger-broken-pipe-"));
  childPath = join(scratchDir, "writer.ts");
  writeFileSync(childPath, CHILD_SOURCE, "utf-8");
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("CLI logger against a real broken pipe", () => {
  test("keeps running after the reader exits", () => {
    const { status, stderr } = runAgainstClosedReader();

    // The specific failure this guards against. Asserted before the positive
    // case so a regression reports the actual errno rather than a bare
    // "SURVIVED not found".
    expect(stderr).not.toContain("UNCAUGHT");
    expect(stderr).toContain("SURVIVED");
    expect(status).toBe(0);
  });

  test("attempts every write after the pipe breaks", () => {
    // Guards against passing for the wrong reason: a child that exited early,
    // or never wrote enough to outlive `head`, would still avoid a crash.
    const { stderr } = runAgainstClosedReader();

    expect(stderr).toContain(`SURVIVED lines=${TOTAL_LINES}`);
  });
});
