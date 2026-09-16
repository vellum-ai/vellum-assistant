/**
 * Tests for `buffer-file.ts`: the two writers of `memory/buffer.md`.
 *
 * The consume cases pin the invariant the module exists for: an entry saved
 * at any point while a consolidation run is in flight is either the run's
 * own material or still in the buffer afterwards, never destroyed. The
 * cross-process case is the reason to believe it: a child process appends
 * as fast as it can while this process consumes in a loop, and every tagged
 * entry must end up consumed or present. The same harness run against a
 * naive read-modify-write consume loses entries, which is what the
 * mechanism is measured against.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  appendBufferAndArchive,
  consumeBufferEntries,
} from "../buffer-file.js";
import {
  type BufferEntryLines,
  bufferEntryText,
  formatRememberEntry,
  joinBufferEntries,
  splitBufferContent,
} from "../buffer-format.js";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-buffer-file-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let memoryDir: string;
let bufferPath: string;
beforeEach(() => {
  memoryDir = mkdtempSync(join(tmp, "memory-"));
  bufferPath = join(memoryDir, "buffer.md");
});

const A = "- [Apr 27, 9:00 AM] Alice prefers VS Code.";
const B = "- [Apr 27, 9:01 AM] Bob shared a snippet:\n  line two\n  line three";
const C = "- [Apr 27, 9:02 AM] Carol loves jazz.";
const D = "- [Apr 27, 9:03 AM] Dave runs marathons.";

function file(...entries: string[]): string {
  return entries.map((e) => `${e}\n`).join("");
}
function entries(content: string): BufferEntryLines[] {
  return splitBufferContent(content);
}
function texts(): string[] {
  return entries(readFileSync(bufferPath, "utf-8")).map(bufferEntryText);
}

describe("appendBufferAndArchive", () => {
  test("appends to the buffer and the dated archive, seeding the archive header once", () => {
    const now = new Date(2026, 3, 27, 9, 0);
    const entry = formatRememberEntry("Alice prefers VS Code.", now);
    const first = appendBufferAndArchive({ rootDir: memoryDir, entry, now });
    appendBufferAndArchive({ rootDir: memoryDir, entry, now });

    expect(first.bufferPath).toBe(bufferPath);
    expect(readFileSync(bufferPath, "utf-8")).toBe(entry + entry);
    expect(first.archivePath).toBe(join(memoryDir, "archive", "2026-04-27.md"));
    expect(readFileSync(first.archivePath, "utf-8")).toBe(
      `# Apr 27, 2026\n\n${entry}${entry}`,
    );
  });
});

describe("consumeBufferEntries", () => {
  test("removes exactly the consumed entries and keeps the rest verbatim and in order", async () => {
    writeFileSync(bufferPath, file(A, B, C, D));
    const pass = entries(file(A, B));

    const result = await consumeBufferEntries(bufferPath, pass, {
      lateAppendGraceMs: 0,
    });

    expect(result).toEqual({
      removed: 2,
      alreadyAbsent: 0,
      lateAppendBytesRecovered: 0,
      unrecoveredLateAppendBytes: 0,
      lateAppendDrainFailed: false,
    });
    expect(readFileSync(bufferPath, "utf-8")).toBe(file(C, D));
  });

  test("entries appended after the snapshot survive, including one that duplicates a consumed entry", async () => {
    // The snapshot held one copy of A; the same fact was remembered again
    // during the run. Multiset semantics: one copy goes, one stays.
    writeFileSync(bufferPath, file(A, B));
    const pass = entries(file(A, B));
    appendFileSync(bufferPath, file(C, A));

    const result = await consumeBufferEntries(bufferPath, pass, {
      lateAppendGraceMs: 0,
    });

    expect(result.removed).toBe(2);
    expect(texts()).toEqual([C, A]);
  });

  test("a consumed entry missing from the live file is counted, not searched for", async () => {
    writeFileSync(bufferPath, file(B, C));
    const pass = entries(file(A, B));

    const result = await consumeBufferEntries(bufferPath, pass, {
      lateAppendGraceMs: 0,
    });

    expect(result).toMatchObject({ removed: 1, alreadyAbsent: 1 });
    expect(texts()).toEqual([C]);
  });

  test("a missing buffer file consumes nothing and creates nothing", async () => {
    const result = await consumeBufferEntries(bufferPath, entries(file(A)), {
      lateAppendGraceMs: 0,
    });

    expect(result).toEqual({
      removed: 0,
      alreadyAbsent: 1,
      lateAppendBytesRecovered: 0,
      unrecoveredLateAppendBytes: 0,
      lateAppendDrainFailed: false,
    });
    expect(existsSync(bufferPath)).toBe(false);
  });

  test("consuming everything leaves an empty file and no temp file behind", async () => {
    writeFileSync(bufferPath, file(A, B));

    await consumeBufferEntries(bufferPath, entries(file(A, B)), {
      lateAppendGraceMs: 0,
    });

    expect(readFileSync(bufferPath, "utf-8")).toBe("");
    expect(readdirSync(memoryDir)).toEqual(["buffer.md"]);
  });

  test("an append that landed on the replaced inode is drained back into the buffer", async () => {
    // An appender that opened the file before the rename writes to the old
    // inode. The consumer holds that inode open and copies the late bytes
    // over. The test plays the appender: open before, write after the
    // synchronous phase, before the grace-window drain.
    writeFileSync(bufferPath, file(A, B));
    const lateFd = openSync(bufferPath, "a");
    const consuming = consumeBufferEntries(bufferPath, entries(file(A)), {
      lateAppendGraceMs: 50,
    });
    // The synchronous phase (read, rewrite, rename) ran before the first
    // await inside consume, so this write lands on the orphaned inode.
    appendFileSync(lateFd, file(C));
    closeSync(lateFd);

    const result = await consuming;

    expect(result.removed).toBe(1);
    expect(result.lateAppendBytesRecovered).toBe(file(C).length);
    expect(result.unrecoveredLateAppendBytes).toBe(0);
    expect(texts()).toEqual([B, C]);
  });

  test("a late append the drain cannot copy back is reported, not thrown, and the pass stays consumed", async () => {
    // The rename has committed when the drain runs, so a failing copy must
    // not surface as "nothing happened". The test makes the rewritten
    // buffer read-only before the late bytes land, so every copy attempt
    // fails.
    writeFileSync(bufferPath, file(A, B));
    const lateFd = openSync(bufferPath, "a");
    const consuming = consumeBufferEntries(bufferPath, entries(file(A)), {
      lateAppendGraceMs: 50,
    });
    chmodSync(bufferPath, 0o444);
    appendFileSync(lateFd, file(C));
    closeSync(lateFd);

    try {
      const result = await consuming;
      expect(result.removed).toBe(1);
      expect(result.lateAppendBytesRecovered).toBe(0);
      expect(result.unrecoveredLateAppendBytes).toBe(file(C).length);
      expect(result.lateAppendDrainFailed).toBe(false);
      expect(texts()).toEqual([B]);
    } finally {
      chmodSync(bufferPath, 0o644);
    }
  });
});

/**
 * The cross-process invariant. A child appends `count` tagged entries as
 * fast as it can through `appendFileSync`; this process consumes the leading
 * entries (up to `passSize` at a time) in a loop through `consume`. Returns
 * the tags that were neither consumed by a pass nor left in the buffer: the
 * entries the consume destroyed.
 */
async function lostUnder(
  consume: (path: string, pass: BufferEntryLines[]) => Promise<unknown>,
  count: number,
  passSize: number,
): Promise<{ lost: string[]; duplicated: string[]; passes: number }> {
  const tag = `t${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(bufferPath, "");
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "buffer-appender.ts"),
      bufferPath,
      String(count),
      tag,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  const consumed: string[] = [];
  let passes = 0;
  let childDone = false;
  void child.exited.then(() => {
    childDone = true;
  });
  while (!childDone) {
    const snapshot = entries(readFileSync(bufferPath, "utf-8"));
    const pass = snapshot.slice(0, passSize);
    if (pass.length === 0) {
      await Bun.sleep(1);
      continue;
    }
    await consume(bufferPath, pass);
    consumed.push(...pass.map(bufferEntryText));
    passes += 1;
  }
  await child.exited;
  const seen = new Map<string, number>();
  for (const text of [...consumed, ...texts()]) {
    seen.set(text, (seen.get(text) ?? 0) + 1);
  }
  const lost: string[] = [];
  const duplicated: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = `- [Apr 27, 9:00 AM] ${tag}-${i}`;
    const n = seen.get(text) ?? 0;
    if (n === 0) {
      lost.push(text);
    } else if (n > 1) {
      duplicated.push(text);
    }
  }
  return { lost, duplicated, passes };
}

/** The read-modify-write the production consume replaces. */
async function naiveConsume(
  path: string,
  pass: BufferEntryLines[],
): Promise<void> {
  const pending = pass.map(bufferEntryText);
  const remaining = entries(readFileSync(path, "utf-8")).filter((entry) => {
    const index = pending.indexOf(bufferEntryText(entry));
    if (index === -1) {
      return true;
    }
    pending.splice(index, 1);
    return false;
  });
  writeFileSync(path, joinBufferEntries(remaining), "utf-8");
}

describe("consumeBufferEntries under a concurrent appender in another process", () => {
  const APPENDS = 4000;

  test("no entry appended during consumption is lost or duplicated", async () => {
    // Runs the consume exactly as production does, grace window included:
    // the window is what makes the invariant hold, and a loaded machine
    // can deschedule the appender between its open and its write for
    // longer than a token grace would cover. Larger passes keep the run
    // short with the full grace paid per pass.
    const outcome = await lostUnder(
      (path, pass) => consumeBufferEntries(path, pass),
      APPENDS,
      500,
    );
    expect(outcome.passes).toBeGreaterThan(0);
    expect(outcome.lost).toEqual([]);
    expect(outcome.duplicated).toEqual([]);
  }, 60_000);

  test("the naive read-modify-write consume loses entries under the same load", async () => {
    // Sensitivity check for the harness: the mechanism above is only
    // evidence if this shape, run identically, fails.
    const outcome = await lostUnder(naiveConsume, APPENDS, 500);
    expect(outcome.passes).toBeGreaterThan(0);
    expect(outcome.lost.length).toBeGreaterThan(0);
  }, 60_000);
});
