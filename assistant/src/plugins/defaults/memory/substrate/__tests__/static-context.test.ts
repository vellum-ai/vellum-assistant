/**
 * Tests for `readMemoryV2StaticContent` — the loader that powers the
 * `memory-v2-static` user-message auto-injection.
 *   - Returns null when `config.memory.v2.enabled` is off.
 *   - Reads the four files in canonical order and joins them under headings.
 *   - Skips empty / missing files.
 *   - Returns null when every file is empty or missing.
 *   - Caps the Buffer section at `consolidation_max_buffer_lines`.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../../../../../util/logger.js");
mock.module("../../../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

let configMemoryV2Enabled = true;
let configMemoryEnabled = true;
// Mirrors the `memory.v2.consolidation_max_buffer_lines` schema default; the
// Buffer-cap tests move it.
let configMaxBufferLines: number | null = 100;

// static-context reads its gates and the substrate tuning through the
// plugin's own config accessor.
mock.module("../../config.js", () => ({
  getMemoryConfig: () => ({
    enabled: configMemoryEnabled,
    v2: {
      enabled: configMemoryV2Enabled,
      consolidation_max_buffer_lines: configMaxBufferLines,
    },
  }),
}));

const { readMemoryV2StaticContent, shouldExposePersonalMemory } =
  await import("../static-context.js");

const MEMORY_FILES = [
  "essentials.md",
  "threads.md",
  "recent.md",
  "buffer.md",
] as const;

function writeMemoryFile(name: string, body: string): void {
  const memoryDir = join(TEST_DIR, "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, name), body);
}

function cleanupMemoryDir(): void {
  const memoryDir = join(TEST_DIR, "memory");
  if (existsSync(memoryDir)) {
    rmSync(memoryDir, { recursive: true, force: true });
  }
}

describe("readMemoryV2StaticContent", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    configMemoryV2Enabled = true;
    configMemoryEnabled = true;
    configMaxBufferLines = 100;
  });

  afterEach(() => {
    cleanupMemoryDir();
  });

  test("returns null when config.memory.v2.enabled is off", () => {
    configMemoryV2Enabled = false;
    for (const file of MEMORY_FILES) {
      writeMemoryFile(file, `Content ${file}`);
    }
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  test("returns null when config.memory.enabled is off even with v2 on", () => {
    configMemoryEnabled = false;
    for (const file of MEMORY_FILES) {
      writeMemoryFile(file, `Content ${file}`);
    }
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  test("returns headed sections in canonical order when all files have content", () => {
    writeMemoryFile("essentials.md", "Alice prefers dark mode.");
    writeMemoryFile("threads.md", "Open thread: ship PR-123 review.");
    writeMemoryFile(
      "recent.md",
      "Yesterday Alice asked about Postgres tuning.",
    );
    writeMemoryFile(
      "buffer.md",
      "Bob mentioned a pager rotation conflict on Friday.",
    );

    const result = readMemoryV2StaticContent();
    expect(result).not.toBeNull();
    const text = result!;

    expect(text).toContain("## Essentials");
    expect(text).toContain("## Threads");
    expect(text).toContain("## Recent");
    expect(text).toContain("## Buffer");
    expect(text).toContain("Alice prefers dark mode.");
    expect(text).toContain(
      "Bob mentioned a pager rotation conflict on Friday.",
    );

    expect(text.indexOf("## Essentials")).toBeLessThan(
      text.indexOf("## Threads"),
    );
    expect(text.indexOf("## Threads")).toBeLessThan(text.indexOf("## Recent"));
    expect(text.indexOf("## Recent")).toBeLessThan(text.indexOf("## Buffer"));
  });

  test("excludeBuffer drops the Buffer section but keeps the other three", () => {
    for (const file of MEMORY_FILES) {
      writeMemoryFile(file, `Content ${file}`);
    }

    const result = readMemoryV2StaticContent({ excludeBuffer: true });
    expect(result).not.toBeNull();
    expect(result!).toContain("## Essentials");
    expect(result!).toContain("## Threads");
    expect(result!).toContain("## Recent");
    expect(result!).not.toContain("## Buffer");
    expect(result!).not.toContain("Content buffer.md");
  });

  test("omits empty files but keeps populated ones", () => {
    writeMemoryFile("essentials.md", "Alice prefers VS Code.");
    writeMemoryFile("threads.md", "");
    writeMemoryFile("recent.md", "Recent topic: GraphQL pagination.");
    writeMemoryFile("buffer.md", "");

    const text = readMemoryV2StaticContent();
    expect(text).not.toBeNull();
    expect(text).toContain("## Essentials");
    expect(text).toContain("## Recent");
    expect(text).not.toContain("## Threads");
    expect(text).not.toContain("## Buffer");
  });

  test("returns null when every file is empty", () => {
    for (const file of MEMORY_FILES) {
      writeMemoryFile(file, "");
    }
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  test("returns null when memory directory is missing entirely", () => {
    cleanupMemoryDir();
    expect(readMemoryV2StaticContent()).toBeNull();
  });
});

describe("readMemoryV2StaticContent Buffer cap", () => {
  /** `n` timestamped buffer entries, oldest first, in `remember()`'s shape. */
  function bufferEntries(n: number): string {
    return Array.from(
      { length: n },
      (_, i) => `- [Jan 1, 9:00 AM] entry-${i}`,
    ).join("\n");
  }

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    configMemoryV2Enabled = true;
    configMemoryEnabled = true;
    configMaxBufferLines = 10;
  });

  afterEach(() => {
    cleanupMemoryDir();
  });

  test("passes a buffer at or under the cap through byte-identically", () => {
    const buffer = bufferEntries(10);
    writeMemoryFile("buffer.md", buffer);

    expect(readMemoryV2StaticContent()).toBe(`## Buffer\n\n${buffer}`);
  });

  test("keeps the newest entries and drops the oldest when over the cap", () => {
    writeMemoryFile("buffer.md", bufferEntries(30));

    const text = readMemoryV2StaticContent()!;
    expect(text).toContain(
      "(Older entries trimmed. Read memory/buffer.md for the full backlog.)",
    );
    // The cap counts non-empty lines, matching the scheduler's
    // `countBufferLines`, so exactly the newest 10 entries survive.
    const kept = text
      .split("\n")
      .filter((line) => line.startsWith("- ["))
      .map((line) => line.slice(line.lastIndexOf(" ") + 1));
    expect(kept).toEqual(
      Array.from({ length: 10 }, (_, i) => `entry-${i + 20}`),
    );
  });

  test("never opens mid-entry when the cap lands inside a multiline fact", () => {
    // The 5-line fact straddles the cap: counting back 10 non-empty lines
    // lands on one of its continuation lines. Injecting from there would show
    // orphan bullets with no timestamp and no opening clause.
    const multiline = [
      "- [Jan 1, 9:00 AM] the straddling fact",
      "  - [ ] a checklist item inside the fact",
      "  continuation prose",
      "  - another bullet",
      "  closing line",
    ].join("\n");
    writeMemoryFile(
      "buffer.md",
      `${bufferEntries(20)}\n${multiline}\n${bufferEntries(8)}`,
    );

    const text = readMemoryV2StaticContent()!;
    const body = text.slice(text.indexOf("buffer.md for the full backlog.)\n"));
    const firstLine = body.split("\n")[1]!;
    expect(firstLine).toMatch(/^- \[Jan 1, 9:00 AM\]/);
    // The partial entry is dropped whole: none of its continuation lines
    // survive on their own.
    expect(text).not.toContain("continuation prose");
    expect(text).not.toContain("the straddling fact");
  });

  test("keeps the newest entry attributable when its body alone exceeds the cap", () => {
    // The newest entry has no successor to fall back to: counting back 10
    // non-empty lines lands inside its body and there is no later timestamped
    // entry to open on. Dropping it would leave the section with no facts at
    // all, so the entry's opening line is kept and its head elided.
    writeMemoryFile(
      "buffer.md",
      [
        ...Array.from(
          { length: 20 },
          (_, i) => `- [Jan 1, 9:00 AM] entry-${i}`,
        ),
        "- [Jan 2, 9:00 AM] the oversized fact",
        ...Array.from({ length: 14 }, (_, i) => `  body line ${i}`),
      ].join("\n"),
    );

    const text = readMemoryV2StaticContent()!;
    const body = text
      .slice(text.indexOf("full backlog.)\n") + "full backlog.)\n".length)
      .split("\n")
      .filter((line) => line.trim().length > 0);

    // Opens on the entry's own timestamped line, never on an orphan body line.
    expect(body[0]).toBe("- [Jan 2, 9:00 AM] the oversized fact");
    expect(body[1]).toBe(
      "(This entry's body was trimmed. Read memory/buffer.md for the rest of it.)",
    );
    // The retained tail is the newest end of the body, not its head.
    expect(body.at(-1)).toBe("  body line 13");
    expect(body).toContain("  body line 4");
    expect(body).not.toContain("  body line 3");
    // Bounded at the cap plus exactly the opening line and the marker, so the
    // oversized entry cannot reintroduce an unbounded injection.
    expect(body).toHaveLength(12);
    // The older entries are still dropped.
    expect(text).not.toContain("entry-19");
  });

  test("does not claim a trim when the newest entry's body exactly fills the cap", () => {
    // The cut lands on the line right after the opening, so nothing of the
    // entry was elided and the marker would be a lie.
    writeMemoryFile(
      "buffer.md",
      [
        ...Array.from(
          { length: 20 },
          (_, i) => `- [Jan 1, 9:00 AM] entry-${i}`,
        ),
        "- [Jan 2, 9:00 AM] the exact-fit fact",
        ...Array.from({ length: 10 }, (_, i) => `  body line ${i}`),
      ].join("\n"),
    );

    const text = readMemoryV2StaticContent()!;
    const body = text
      .slice(text.indexOf("full backlog.)\n") + "full backlog.)\n".length)
      .split("\n")
      .filter((line) => line.trim().length > 0);

    expect(body[0]).toBe("- [Jan 2, 9:00 AM] the exact-fit fact");
    expect(text).not.toContain("This entry's body was trimmed");
    // The entry survives whole: opening line plus its full 10-line body.
    expect(body).toHaveLength(11);
    expect(body.at(-1)).toBe("  body line 9");
    expect(body).toContain("  body line 0");
  });

  test("keeps a multiline entry intact when it sits fully inside the cap", () => {
    const multiline = [
      "- [Jan 1, 9:00 AM] a fact with a body",
      "  second line of the same fact",
    ].join("\n");
    writeMemoryFile("buffer.md", `${bufferEntries(20)}\n${multiline}`);

    const text = readMemoryV2StaticContent()!;
    expect(text).toContain("a fact with a body");
    expect(text).toContain("second line of the same fact");
  });

  test("falls back to the line cut for a buffer with no timestamped entries", () => {
    // A hand-written buffer that never went through `remember()` has no entry
    // structure to preserve, so the line-based cut stands rather than dropping
    // everything.
    const handWritten = Array.from(
      { length: 30 },
      (_, i) => `just a line ${i}`,
    ).join("\n");
    writeMemoryFile("buffer.md", handWritten);

    const text = readMemoryV2StaticContent()!;
    expect(text).toContain("just a line 29");
    expect(text).not.toContain("just a line 0");
  });

  test("leaves the buffer unbounded when the size trigger is disabled", () => {
    configMaxBufferLines = null;
    const buffer = bufferEntries(30);
    writeMemoryFile("buffer.md", buffer);

    expect(readMemoryV2StaticContent()).toBe(`## Buffer\n\n${buffer}`);
  });

  test("caps only the Buffer section, never the curated views", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
    writeMemoryFile("essentials.md", long);
    writeMemoryFile("threads.md", long);
    writeMemoryFile("recent.md", long);
    writeMemoryFile("buffer.md", bufferEntries(30));

    const lines = readMemoryV2StaticContent()!.split("\n");
    expect(lines.filter((line) => line === "line-0")).toHaveLength(3);
    expect(lines.filter((line) => line === "line-29")).toHaveLength(3);
    expect(lines.some((line) => line.endsWith("entry-0"))).toBe(false);
  });
});

describe("shouldExposePersonalMemory", () => {
  test("allows guardian-trusted local conversations", () => {
    expect(
      shouldExposePersonalMemory({
        sourceChannel: "vellum",
        isTrustedActor: true,
      }),
    ).toBe(true);
  });

  test("allows local-channel conversations even when trust class is unknown (analyze runs, dev)", () => {
    expect(
      shouldExposePersonalMemory({
        sourceChannel: "vellum",
        isTrustedActor: false,
      }),
    ).toBe(true);
  });

  test("allows turns with no trust context (work-item task runs, internal background)", () => {
    expect(
      shouldExposePersonalMemory({
        sourceChannel: undefined,
        isTrustedActor: false,
      }),
    ).toBe(true);
  });

  const REMOTE_CHANNELS = [
    "phone",
    "slack",
    "telegram",
    "whatsapp",
    "email",
  ] as const;

  test("allows guardian-trusted remote channels (user's own phone/Slack)", () => {
    for (const channel of REMOTE_CHANNELS) {
      expect(
        shouldExposePersonalMemory({
          sourceChannel: channel,
          isTrustedActor: true,
        }),
      ).toBe(true);
    }
  });

  test("blocks non-guardian remote-channel actors (the leak this gate exists to prevent)", () => {
    for (const channel of REMOTE_CHANNELS) {
      expect(
        shouldExposePersonalMemory({
          sourceChannel: channel,
          isTrustedActor: false,
        }),
      ).toBe(false);
    }
  });
});
