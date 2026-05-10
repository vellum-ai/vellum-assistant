/**
 * Tests for `assistant/src/memory/v2/frontmatter-sweep.ts`.
 *
 * Coverage:
 *   - Empty workspace → no warns, no throw.
 *   - One bad page (unknown frontmatter key) → exactly one warn carrying
 *     `errCode: "unrecognized_keys"` and the offending slug.
 *   - Two bad + one good page → two warns; good page produces nothing.
 *   - Malformed YAML → a warn surfaces; the sweep does not crash.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const warnCalls: Array<{ data: Record<string, unknown>; msg: string }> = [];
const recordingLogger = {
  warn: (data: Record<string, unknown>, msg: string) => {
    warnCalls.push({ data, msg });
  },
  info: () => {},
  debug: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => recordingLogger,
};

mock.module("../../../util/logger.js", () => ({
  getLogger: () => recordingLogger,
}));

const { sweepConceptPageFrontmatter } = await import("../frontmatter-sweep.js");

function makeWorkspace(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "frontmatter-sweep-"));
  const conceptsDir = join(dir, "memory", "concepts");
  if (Object.keys(pages).length > 0) {
    mkdirSync(conceptsDir, { recursive: true });
    for (const [slug, content] of Object.entries(pages)) {
      writeFileSync(join(conceptsDir, `${slug}.md`), content, "utf-8");
    }
  }
  return dir;
}

const goodPage = `---\nedges: []\nref_files: []\n---\nbody\n`;
const badPage = `---\nedges: []\nref_files: []\nbogus_field: 1\n---\nbody\n`;

describe("sweepConceptPageFrontmatter", () => {
  beforeEach(() => {
    warnCalls.length = 0;
  });
  afterEach(() => {
    warnCalls.length = 0;
  });

  test("empty workspace: no warns, no throw", async () => {
    const dir = makeWorkspace({});
    try {
      await sweepConceptPageFrontmatter(dir);
      expect(warnCalls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one bad page emits exactly one unrecognized_keys warn", async () => {
    const dir = makeWorkspace({ "bad-one": badPage });
    try {
      await sweepConceptPageFrontmatter(dir);
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0].data.slug).toBe("bad-one");
      expect(warnCalls[0].data.errCode).toBe("unrecognized_keys");
      expect(warnCalls[0].data.errKeys).toEqual(["bogus_field"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two bad and one good page: one warn per bad slug, none for the good", async () => {
    const dir = makeWorkspace({
      good: goodPage,
      "bad-a": badPage,
      "bad-b": badPage,
    });
    try {
      await sweepConceptPageFrontmatter(dir);
      const slugs = warnCalls.map((c) => c.data.slug).sort();
      expect(slugs).toEqual(["bad-a", "bad-b"]);
      for (const call of warnCalls) {
        expect(call.data.errCode).toBe("unrecognized_keys");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed YAML: warn surfaces, sweep does not throw", async () => {
    const dir = makeWorkspace({
      mangled: `---\nedges: [unterminated\n---\nbody\n`,
    });
    try {
      await sweepConceptPageFrontmatter(dir);
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      expect(warnCalls.some((c) => c.data.slug === "mangled")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
