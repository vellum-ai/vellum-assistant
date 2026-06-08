import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SEEDS } from "@vellumai/environments";

// Drift guard between the two language-level sources of truth for the set of
// known environment names:
//
//   1. packages/environments/src/seeds.ts       — SEEDS record (TS source of truth)
//   2. clients/shared/App/VellumEnvironment.swift — Swift `VellumEnvironment` enum
//
// The Swift client can't import the TypeScript package, so the two lists are
// maintained independently and must be kept in lockstep by hand. This test
// parses the enum cases out of the Swift source and asserts they agree with
// SEEDS. Adding an environment means updating both sites.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SWIFT_ENVIRONMENT = join(
  REPO_ROOT,
  "clients",
  "shared",
  "App",
  "VellumEnvironment.swift",
);

/**
 * Extract the case names declared in the `VellumEnvironment` enum. Matches
 * standalone `case <name>` declaration lines (one identifier, nothing else),
 * which is the enum's own declaration syntax. Switch-statement arms like
 * `case .local:` carry a leading dot and a trailing colon, so they're
 * excluded — the match is anchored to a bare identifier at end of line.
 */
function extractSwiftEnumCases(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split("\n")) {
    const match = line.match(/^\s*case\s+([a-zA-Z][a-zA-Z0-9]*)\s*$/);
    if (match) names.push(match[1]!);
  }
  return names;
}

describe("environment name drift guard (TS ↔ Swift)", () => {
  const seedNames = new Set(Object.keys(SEEDS));

  test("clients/shared/App/VellumEnvironment.swift matches SEEDS", () => {
    const source = readFileSync(SWIFT_ENVIRONMENT, "utf8");
    const swiftNames = new Set(extractSwiftEnumCases(source));

    expect(swiftNames.size).toBeGreaterThan(0);
    expect([...swiftNames].sort()).toEqual([...seedNames].sort());
  });
});
