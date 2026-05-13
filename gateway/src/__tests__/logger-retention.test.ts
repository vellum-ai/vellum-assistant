import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initLogger,
  pruneOldLogFiles,
  getLogger,
} from "../logger.js";

// NOTE: `sleep-wake-detector.test.ts` installs a process-global
// `mock.module("../logger.js", …)` with a no-op `initLogger`. That would
// break the `initLogger prunes once at startup` case below if both files
// ran in the same Bun process. They don't — `gateway/scripts/test.sh` runs
// each test file in its own `bun test` invocation precisely to dodge this
// class of mock cross-talk. If you ever invoke `bun test` directly across
// multiple files, expect order-dependent flakes and use the canonical
// runner (`bun run test`) instead.

/**
 * Helper that fabricates a log file dated `daysAgo` calendar days ago, in
 * either pretty `.log` or sidecar `.jsonl` form. Used to assert that the
 * retention sweep prunes both formats once `retentionDays` has elapsed.
 */
function makeLogFile(dir: string, daysAgo: number, ext: "log" | "jsonl"): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const name = `gateway-${stamp}.${ext}`;
  writeFileSync(join(dir, name), `placeholder for ${stamp}\n`);
  return name;
}

describe("gateway log retention", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gw-retention-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("pruneOldLogFiles removes both .log and .jsonl past retention", () => {
    const young = makeLogFile(tmp, 1, "log");
    const youngJsonl = makeLogFile(tmp, 1, "jsonl");
    const old = makeLogFile(tmp, 10, "log");
    const oldJsonl = makeLogFile(tmp, 10, "jsonl");

    const removed = pruneOldLogFiles(tmp, 7);

    expect(removed).toBe(2);
    const remaining = readdirSync(tmp).sort();
    expect(remaining).toEqual([young, youngJsonl].sort());
    expect(existsSync(join(tmp, old))).toBe(false);
    expect(existsSync(join(tmp, oldJsonl))).toBe(false);
  });

  test("pruneOldLogFiles ignores unrelated files in the log dir", () => {
    makeLogFile(tmp, 10, "log");
    writeFileSync(join(tmp, "something-else.log"), "not a gateway log\n");
    writeFileSync(join(tmp, "README"), "noise\n");

    pruneOldLogFiles(tmp, 7);

    expect(existsSync(join(tmp, "something-else.log"))).toBe(true);
    expect(existsSync(join(tmp, "README"))).toBe(true);
  });

  test("initLogger prunes once at startup", () => {
    const old = makeLogFile(tmp, 10, "log");
    const oldJsonl = makeLogFile(tmp, 10, "jsonl");

    initLogger({ dir: tmp, retentionDays: 7 });

    expect(existsSync(join(tmp, old))).toBe(false);
    expect(existsSync(join(tmp, oldJsonl))).toBe(false);
    // Detach from this temp dir before the test teardown rmSyncs it.
    initLogger({ dir: undefined, retentionDays: 0 });
  });

  test("retentionDays=0 disables pruning", () => {
    const old = makeLogFile(tmp, 365, "log");

    // Exercises the guard directly; doesn't depend on `initLogger`'s
    // module-level state (or any mocks thereof).
    const removed = pruneOldLogFiles(tmp, 0);

    expect(removed).toBe(0);
    expect(existsSync(join(tmp, old))).toBe(true);
  });

  test("retentionDays<0 also disables pruning (defense-in-depth)", () => {
    const old = makeLogFile(tmp, 365, "log");
    expect(pruneOldLogFiles(tmp, -7)).toBe(0);
    expect(existsSync(join(tmp, old))).toBe(true);
  });

  test("getLogger() works against a configured dir without throwing", () => {
    initLogger({ dir: tmp, retentionDays: 7 });
    const log = getLogger("retention-test");
    // Smoke: just verify the proxy yields a callable .info — full file
    // emission is covered by the smoke test in logger.ts's own usage.
    expect(typeof log.info).toBe("function");
    initLogger({ dir: undefined, retentionDays: 0 });
  });
});
