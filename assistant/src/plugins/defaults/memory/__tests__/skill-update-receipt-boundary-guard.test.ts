/**
 * The receipt job announces a receipt through the notification pipeline and
 * reads what the pipeline did; it never writes the home feed itself and
 * never releases a dedupe key the pipeline kept. A verdict the pipeline
 * reached (a block, a suppression, a no-notify decision) is the pipeline's to
 * make, and a home-feed row written from here would be a notification the
 * routing declined. This guard pins the import surface that keeps that so.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const MODULE_DIR = join(import.meta.dir, "..");

function importedNames(file: string): string[] {
  const source = readFileSync(join(MODULE_DIR, file), "utf-8");
  const names: string[] = [];
  for (const match of source.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from/g,
  )) {
    for (const raw of match[1]!.split(",")) {
      const name = raw
        .replace(/^\s*type\s+/, "")
        .split(/\s+as\s+/)[0]!
        .trim();
      if (name) {
        names.push(name);
      }
    }
  }
  return names;
}

describe("skill-update receipt boundary", () => {
  for (const file of ["skill-update-receipt-job.ts"]) {
    test(`${file} neither writes the home feed nor releases a dedupe key`, () => {
      const names = importedNames(file);
      expect(names).not.toContain("appendFeedItem");
      expect(names).not.toContain("patchFeedItemContent");
      expect(names).not.toContain("writeHomeFeedItemForSignal");
      expect(names).not.toContain("setEventDedupeKey");
    });
  }
});
