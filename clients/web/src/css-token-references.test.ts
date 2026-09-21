/**
 * Guard against `var(--token)` references to a token nothing defines.
 *
 * An undefined custom property does not fail loudly. The declaration that
 * reads it becomes invalid at computed-value time, so a colour falls back to
 * the inherited one and a focus ring paints nothing. An audit on 2026-09-18
 * found 34 such names across 72 call sites, among them the link colour behind
 * `Button variant="link"` and the ring colour on a dozen hand-rolled controls.
 *
 * A reference passes when the name is declared in a stylesheet, set from
 * script (an inline style key, a Tailwind `[--name:value]` utility, or
 * `setProperty`), or carries its own fallback (`var(--a, fallback)`).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const WEB_SRC = import.meta.dir;
const REPO_ROOT = join(WEB_SRC, "..", "..", "..");
const SCAN_ROOTS = [
  WEB_SRC,
  join(REPO_ROOT, "packages", "design-library", "src"),
];
const SKIPPED_DIRS = new Set(["node_modules", "generated", "dist"]);

/** Names the platform or a dependency defines at runtime, not our CSS. */
const EXTERNAL_PREFIXES = ["--tw-", "--radix-"];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, found);
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (line, lead: string) => lead);
}

interface Reference {
  name: string;
  location: string;
}

function collect(): { defined: Set<string>; references: Reference[] } {
  const defined = new Set<string>();
  const references: Reference[] = [];
  for (const file of SCAN_ROOTS.flatMap((root) => sourceFiles(root))) {
    const source = stripComments(readFileSync(file, "utf8"));
    // `--name: value` in CSS, an object key, or a `[--name:value]` utility.
    for (const match of source.matchAll(/(--[a-zA-Z][\w-]*)["'`]?\]?\s*:/g)) {
      defined.add(match[1]);
    }
    // `setProperty("--name", ...)` and names held in a string constant.
    for (const match of source.matchAll(/["'`](--[a-zA-Z][\w-]*)["'`]/g)) {
      defined.add(match[1]);
    }
    if (/\.(test|stories)\.tsx?$/.test(file)) {
      continue;
    }
    source.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)\s*\)/g)) {
        references.push({
          name: match[1],
          location: `${relative(REPO_ROOT, file)}:${index + 1}`,
        });
      }
    });
  }
  return { defined, references };
}

describe("CSS custom property references", () => {
  test("every var(--token) without a fallback names a defined token", () => {
    const { defined, references } = collect();
    const undefinedReferences = references
      .filter(({ name }) => !defined.has(name))
      .filter(({ name }) => !EXTERNAL_PREFIXES.some((p) => name.startsWith(p)))
      .map(({ name, location }) => `${name}  ${location}`);
    expect(undefinedReferences).toEqual([]);
  });

  test("the scan sees the design tokens", () => {
    const { defined, references } = collect();
    expect(defined.has("--content-default")).toBe(true);
    expect(defined.has("--content-link")).toBe(true);
    expect(references.length).toBeGreaterThan(1000);
  });
});
