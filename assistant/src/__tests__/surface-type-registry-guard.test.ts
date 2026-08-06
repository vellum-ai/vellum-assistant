import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { SURFACE_TYPES } from "../api/surfaces.js";

/**
 * Guard: every `surfaceType` literal the daemon emits or declares in
 * production code must be a member of the canonical `SURFACE_TYPES` set.
 *
 * This exists because a surface type that is emitted (appended to history as
 * a `ui_surface` block, or sent as `ui_surface_show`) but missing from
 * `SURFACE_TYPES` regresses silently: history restore and the surface content
 * route can't classify it, so it renders wrong or loses its data. The memory
 * retrospective's `skill_card` and a call's `call_summary` are emitted this
 * way; both must stay registered.
 */

const SRC_ROOT = join(import.meta.dir, "..");

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip test trees and generated code — this guard is about production
      // emission sites, and tests deliberately exercise invalid types.
      if (entry === "__tests__" || entry === "generated") {
        continue;
      }
      collectTsFiles(full, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("surface-type registry guard", () => {
  test("every surfaceType literal in production code is in SURFACE_TYPES", () => {
    const registered = new Set<string>(SURFACE_TYPES);
    const literalRe = /surfaceType:\s*"([a-z_]+)"/g;
    const offenders: Array<{ type: string; file: string }> = [];

    for (const file of collectTsFiles(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(literalRe)) {
        const type = match[1];
        if (!registered.has(type)) {
          offenders.push({ type, file: file.slice(SRC_ROOT.length + 1) });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("SURFACE_TYPES includes the daemon-appended card types", () => {
    expect(SURFACE_TYPES).toContain("skill_card");
    expect(SURFACE_TYPES).toContain("call_summary");
  });
});
