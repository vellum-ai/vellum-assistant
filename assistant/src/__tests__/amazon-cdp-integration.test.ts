/**
 * Verify that the Amazon CLI delegates CDP management to the shared
 * chrome-cdp helper instead of owning its own launch/window logic.
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
  test("imports shared CDP helpers instead of defining its own", () => {
    // Should import from the shared module
    expect(amazonSource).toContain('from "../tools/browser/chrome-cdp.js"');

    // Should import the key entrypoints
    expect(amazonSource).toContain("ensureChromeWithCdp");
    expect(amazonSource).toContain("minimizeChromeWindow");
    expect(amazonSource).toContain("restoreChromeWindow");
  });

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
    // After migration, spawn should not be imported or used.
    expect(amazonSource).not.toMatch(/spawn\s+as\s+spawnChild/);
    expect(amazonSource).not.toContain(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  });

  test("still calls ensureChromeWithCdp in the learn session flow", () => {
    // The learn session helper should delegate to the shared entrypoint
    expect(amazonSource).toMatch(/await\s+ensureChromeWithCdp\s*\(/);
  });

  test("passes amazon.com as the start URL", () => {
    expect(amazonSource).toContain("https://www.amazon.com/");
  });
});
