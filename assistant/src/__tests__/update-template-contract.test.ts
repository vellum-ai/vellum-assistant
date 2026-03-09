/**
 * Contract test: ensures the bundled UPDATES.md template exists and is readable.
 *
 * The template may be comment-only (no real content) for no-op releases —
 * the bulletin system treats an empty-after-stripping template as a skip signal.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const TEMPLATE_PATH = join(
  import.meta.dirname,
  "..",
  "prompts",
  "templates",
  "UPDATES.md",
);

describe("UPDATES.md template contract", () => {
  test("template file exists", () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });

  test("template is a readable UTF-8 file", () => {
    const content = readFileSync(TEMPLATE_PATH, "utf-8");
    expect(typeof content).toBe("string");
  });
});
