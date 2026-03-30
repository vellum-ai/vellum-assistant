import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  isAllowlisted,
  loadAllowlist,
  resetAllowlist,
} from "../security/secret-allowlist.js";
import { scanText } from "../security/secret-scanner.js";

describe("secret-allowlist", () => {
  beforeEach(() => {
    mkdirSync(join(testDir, "data"), { recursive: true });
    resetAllowlist();
  });

  afterEach(() => {
    resetAllowlist();
    rmSync(join(testDir, "data"), { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // No file — should not error, everything still detected
  // -----------------------------------------------------------------------
  test("works when no allowlist file exists", () => {
    expect(isAllowlisted("AKIAIOSFODNN7REALKEY")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Exact values
  // -----------------------------------------------------------------------
  test("[experimental] suppresses exact values", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ values: ["my-test-api-key-12345"] }),
    );
    expect(isAllowlisted("my-test-api-key-12345")).toBe(true);
    expect(isAllowlisted("my-test-api-key-99999")).toBe(false);
  });

  test("[experimental] exact values are case-sensitive", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ values: ["MyTestKey"] }),
    );
    expect(isAllowlisted("MyTestKey")).toBe(true);
    expect(isAllowlisted("mytestkey")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Prefix matching
  // -----------------------------------------------------------------------
  test("[experimental] suppresses values matching a prefix", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ prefixes: ["my-internal-"] }),
    );
    expect(isAllowlisted("my-internal-key-abc123")).toBe(true);
    expect(isAllowlisted("other-key-abc123")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Regex patterns
  // -----------------------------------------------------------------------
  test("[experimental] suppresses values matching a regex pattern", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ patterns: ["^ci-test-[a-z0-9]+$"] }),
    );
    expect(isAllowlisted("ci-test-abc123")).toBe(true);
    expect(isAllowlisted("ci-prod-abc123")).toBe(false);
  });

  test("[experimental] invalid regex is skipped without crashing", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ patterns: ["[invalid", "^valid$"] }),
    );
    loadAllowlist();
    // The valid pattern should still work
    expect(isAllowlisted("valid")).toBe(true);
    // Invalid regex is skipped, not thrown
    expect(isAllowlisted("other")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Combined rules
  // -----------------------------------------------------------------------
  test("[experimental] combines values, prefixes, and patterns", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({
        values: ["exact-match-value"],
        prefixes: ["test-prefix-"],
        patterns: ["^regex-[0-9]+$"],
      }),
    );
    expect(isAllowlisted("exact-match-value")).toBe(true);
    expect(isAllowlisted("test-prefix-anything")).toBe(true);
    expect(isAllowlisted("regex-12345")).toBe(true);
    expect(isAllowlisted("none-of-the-above")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Malformed file
  // -----------------------------------------------------------------------
  test("handles malformed JSON gracefully", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      "not json{{{",
    );
    loadAllowlist();
    // Should not throw, just log warning
    expect(isAllowlisted("anything")).toBe(false);
  });

  test("handles non-array fields gracefully", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ values: "not-an-array", prefixes: 42 }),
    );
    loadAllowlist();
    expect(isAllowlisted("not-an-array")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Integration with scanText
  // -----------------------------------------------------------------------
  test("[experimental] allowlisted values are suppressed by scanText", () => {
    const awsKey = "AKIAIOSFODNN7REALKEY";
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ values: [awsKey] }),
    );
    resetAllowlist();

    const matches = scanText(`Found key: ${awsKey}`);
    const aws = matches.filter((m) => m.type === "AWS Access Key");
    expect(aws).toHaveLength(0);
  });

  test("non-allowlisted values are still detected by scanText", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ values: ["AKIAIOSFODNN7OTHERKE"] }),
    );
    resetAllowlist();

    const matches = scanText("Found key: AKIAIOSFODNN7REALKEY");
    const aws = matches.filter((m) => m.type === "AWS Access Key");
    expect(aws).toHaveLength(1);
  });

  test("[experimental] prefix allowlist suppresses pattern matches", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ prefixes: ["ghp_AAAA"] }),
    );
    resetAllowlist();

    const token = `ghp_AAAA${"B".repeat(32)}`;
    const matches = scanText(`token=${token}`);
    const gh = matches.filter((m) => m.type === "GitHub Token");
    expect(gh).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Retry on missing/malformed file
  // -----------------------------------------------------------------------
  test("[experimental] caches missing file check to avoid repeated existsSync", () => {
    // First call — no file exists, caches fileChecked = true
    expect(isAllowlisted("test-key")).toBe(false);

    // Create the file — but fileChecked is cached, so it won't be seen
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ values: ["test-key"] }),
    );
    expect(isAllowlisted("test-key")).toBe(false);

    // After reset, the file should be found
    resetAllowlist();
    expect(isAllowlisted("test-key")).toBe(true);
  });

  test("[experimental] retries loading when file was malformed on first call", () => {
    // First call with malformed JSON
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      "not json{{{",
    );
    loadAllowlist();
    expect(isAllowlisted("test-key")).toBe(false);

    // Fix the file
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ values: ["test-key"] }),
    );

    // Should retry and pick up the fixed file
    expect(isAllowlisted("test-key")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // resetAllowlist
  // -----------------------------------------------------------------------
  test("[experimental] resetAllowlist clears cached state", () => {
    writeFileSync(
      join(testDir, "data", "secret-allowlist.json"),
      JSON.stringify({ values: ["test-value"] }),
    );
    loadAllowlist();
    expect(isAllowlisted("test-value")).toBe(true);

    // Reset and remove file — should no longer be allowlisted
    resetAllowlist();
    rmSync(join(testDir, "data", "secret-allowlist.json"));
    expect(isAllowlisted("test-value")).toBe(false);
  });
});
