/**
 * Every acquisition of the processing flag goes through the fenced helper.
 *
 * `acquireProcessing` hands back a live claim, and the marker fence that has
 * to follow it can fail. A site that calls the two itself owns the ordering,
 * and getting it wrong (fencing outside the try whose finally releases) leaves
 * the conversation processing for good with every later send queued behind a
 * dead hold. `acquireProcessingFenced` owns that ordering once, so the rule is
 * simply that nothing else calls the primitive.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/** Where the primitive and its fenced wrapper legitimately live together. */
const OWNER_FILE = join("src", "daemon", "conversation.ts");

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== "__tests__") {
        sourceFiles(full, found);
      }
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("processing flag acquisition", () => {
  test("only the fenced helper calls the raw acquire", () => {
    const offenders = sourceFiles("src").filter(
      (file) =>
        file !== OWNER_FILE &&
        /\bacquireProcessing\s*\(\s*\)/.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  test("only the fenced helper awaits the marker fence", () => {
    // Same rule for the other half: a site that awaits the fence itself is a
    // site that can await it in the wrong place.
    const offenders = sourceFiles("src").filter(
      (file) =>
        file !== OWNER_FILE &&
        /\bensureProcessingMarker\s*\(/.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});
