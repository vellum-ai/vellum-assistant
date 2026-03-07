/**
 * Verify that the Amazon CLI does NOT define its own CDP launch/window logic.
 *
 * The Amazon CLI now uses browser extension relay instead of CDP for session
 * management, so we only verify that old inline CDP patterns are absent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const AMAZON_CLI_PATH = join(
  import.meta.dirname ?? __dirname,
  "..",
  "cli",
  "amazon.ts",
);
const amazonSource = readFileSync(AMAZON_CLI_PATH, "utf-8");

describe("Amazon CLI CDP integration", () => {
  test("does not define its own CDP_BASE constant", () => {
    // The old inline constant was: const CDP_BASE = "http://localhost:9222";
    expect(amazonSource).not.toMatch(/const\s+CDP_BASE\s*=/);
  });

  test("does not define its own Chrome data dir constant", () => {
    expect(amazonSource).not.toMatch(/const\s+CHROME_DATA_DIR\s*=/);
  });

  test("does not define a local isCdpReady function", () => {
    expect(amazonSource).not.toMatch(/async\s+function\s+isCdpReady\s*\(/);
  });

  test("does not define a local ensureChromeWithCDP function", () => {
    expect(amazonSource).not.toMatch(
      /async\s+function\s+ensureChromeWithCDP\s*\(/,
    );
  });

  test("does not define local minimize/restore window functions", () => {
    expect(amazonSource).not.toMatch(
      /async\s+function\s+minimizeChromeWindow\s*\(/,
    );
    expect(amazonSource).not.toMatch(
      /async\s+function\s+restoreChromeWindow\s*\(/,
    );
  });

  test("does not spawn Chrome directly", () => {
    // The old code imported spawn and called it with the Chrome app path.
    expect(amazonSource).not.toMatch(/spawn\s+as\s+spawnChild/);
    expect(amazonSource).not.toContain(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  });
});
