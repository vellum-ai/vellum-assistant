import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SEEDS } from "../lib/environments/seeds.js";

// Drift guard for the TypeScript sites that hardcode the set of known
// environment names:
//
//   1. cli/src/lib/environments/seeds.ts  — SEEDS record (source of truth)
//   2. assistant/src/util/platform.ts     — KNOWN_ENVIRONMENTS set
//
// Cross-package relative imports don't work here: assistant's tsconfig
// restricts `include` to its own src tree. So this test parses the literal
// set out of the external file and asserts it agrees with CLI's SEEDS.
//
// FOLLOW-UP: split the env name list into a shared `packages/environments`
// package (mirroring `packages/service-contracts`, `credential-storage`) so
// both sites can `import { KNOWN_ENVIRONMENTS }` from one place and this
// drift guard becomes a compile-time check. Planned alongside CLI-driven
// context support — see the "Environments" design doc.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const ASSISTANT_PLATFORM = join(
  REPO_ROOT,
  "assistant",
  "src",
  "util",
  "platform.ts",
);

/**
 * Extract the string literals from a Set constructor body in a TS source
 * file. Looks for `<setName>: ReadonlySet<string> = new Set([ ... ])` and
 * pulls out every `"..."` entry within the array. The match is anchored to
 * the `setName` to avoid picking up unrelated sets that happen to live in
 * the same file.
 */
function extractSetLiterals(source: string, setName: string): string[] {
  const pattern = new RegExp(
    `${setName}\\s*:\\s*ReadonlySet<string>\\s*=\\s*new Set\\(\\[([^\\]]*)\\]`,
    "m",
  );
  const match = source.match(pattern);
  if (!match) {
    throw new Error(
      `Could not find Set literal for ${setName}. Update the drift-guard regex in env-drift.test.ts.`,
    );
  }
  const body = match[1];
  const literals = body.match(/"([^"]+)"/g) ?? [];
  return literals.map((lit) => lit.slice(1, -1));
}

describe("KNOWN_ENVIRONMENTS drift guard (TS-side)", () => {
  const seedNames = new Set(Object.keys(SEEDS));

  test("assistant/src/util/platform.ts KNOWN_ENVIRONMENTS matches CLI SEEDS", () => {
    const source = readFileSync(ASSISTANT_PLATFORM, "utf8");
    const assistantNames = new Set(
      extractSetLiterals(source, "KNOWN_ENVIRONMENTS"),
    );
    expect([...assistantNames].sort()).toEqual([...seedNames].sort());
  });
});
