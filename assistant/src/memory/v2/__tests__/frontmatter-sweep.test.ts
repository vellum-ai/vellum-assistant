/**
 * Tests for `assistant/src/memory/v2/frontmatter-sweep.ts`.
 *
 * Coverage:
 *   - v2 disabled → returns early, no warns, no throw.
 *   - Empty workspace → no warns, no throw.
 *   - One bad page (malformed frontmatter — wrong type on a declared field) →
 *     exactly one warn carrying `errCode: "invalid_type"` and the offending slug.
 *   - Two bad + one good page → two warns; good page produces nothing.
 *   - Malformed YAML → a warn surfaces; the sweep does not crash.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../config/schema.js";

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

/** Minimal config shape the sweep touches; cast to AssistantConfig at the boundary. */
function makeConfig(v2Enabled: boolean): AssistantConfig {
  return {
    memory: {
      v2: { enabled: v2Enabled },
    },
  } as unknown as AssistantConfig;
}

const v2On = makeConfig(true);

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
// Malformed: `edges` is a declared `z.array(z.string())` field, so a scalar
// value fails the schema with `invalid_type`. (An *unknown* key would NOT be
// bad — the schema is `.passthrough()`, so unknown keys are tolerated; the
// sweep only surfaces genuinely malformed pages that `readPage` would throw on.)
const badPage = `---\nedges: not-a-list\nref_files: []\n---\nbody\n`;

describe("sweepConceptPageFrontmatter", () => {
  beforeEach(() => {
    warnCalls.length = 0;
  });
  afterEach(() => {
    warnCalls.length = 0;
  });

  test("does nothing when memory.v2.enabled is false", async () => {
    // Pass a non-existent dir to prove the gate short-circuits BEFORE any I/O:
    // if the body ran, listPages would surface a warn for the unreadable path.
    await sweepConceptPageFrontmatter(makeConfig(false), "/nonexistent/path");
    expect(warnCalls).toHaveLength(0);
  });

  test("empty workspace: no warns, no throw", async () => {
    const dir = makeWorkspace({});
    try {
      await sweepConceptPageFrontmatter(v2On, dir);
      expect(warnCalls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one bad page emits exactly one invalid_type warn", async () => {
    const dir = makeWorkspace({ "bad-one": badPage });
    try {
      await sweepConceptPageFrontmatter(v2On, dir);
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0].data.slug).toBe("bad-one");
      expect(warnCalls[0].data.errCode).toBe("invalid_type");
      expect(warnCalls[0].data.errPath).toEqual(["edges"]);
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
      await sweepConceptPageFrontmatter(v2On, dir);
      const slugs = warnCalls.map((c) => c.data.slug).sort();
      expect(slugs).toEqual(["bad-a", "bad-b"]);
      for (const call of warnCalls) {
        expect(call.data.errCode).toBe("invalid_type");
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
      await sweepConceptPageFrontmatter(v2On, dir);
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
      expect(warnCalls.some((c) => c.data.slug === "mangled")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
