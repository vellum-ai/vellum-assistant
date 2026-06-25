/**
 * Tests for `vellum client --token <jwt> --url <gateway>`: an ephemeral session
 * that authenticates with a handed-over token and needs no lockfile entry.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NB: do NOT mock.module("../lib/guardian-token.js") here — that mock is
// process-global in Bun and leaks into other test files (it dropped the
// module's other exports and broke guardian-token-paths / setup suites in CI).
// The "--token skips the credential lookup" behavior is enforced structurally
// in parseArgs (the lookup is gated on the override) and reviewed there.

// An EMPTY temp dir so there is no lockfile entry — the ephemeral path must
// work without one. Env mutation is scoped to each test and restored after, so
// it can't leak into other test files in the same Bun run.
const testDir = mkdtempSync(join(tmpdir(), "client-token-test-"));
const ORIGINAL_LOCKFILE_DIR = process.env.VELLUM_LOCKFILE_DIR;
const ORIGINAL_ARGV = [...process.argv];

import { parseArgs } from "../commands/client.js";

// A clearly non-local URL so maybeSwapToLocalhost won't rewrite it to 127.0.0.1.
const REMOTE_URL = "http://192.0.2.50:7830";

describe("client --token (ephemeral)", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    if (ORIGINAL_LOCKFILE_DIR === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = ORIGINAL_LOCKFILE_DIR;
    }
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("--url + --token resolves to a bearer session with no lockfile entry", () => {
    process.argv = [
      "bun",
      "vellum",
      "client",
      "--url",
      REMOTE_URL,
      "--token",
      "test-jwt-token",
    ];
    const parsed = parseArgs();

    expect(parsed.runtimeUrl).toBe(REMOTE_URL);
    expect(parsed.assistantId).toBe("self"); // DAEMON_INTERNAL_ASSISTANT_ID
    expect(parsed.bearerToken).toBe("test-jwt-token");
    expect(parsed.platformToken).toBeUndefined();
  });

  test("--assistant-id overrides the default 'self' segment", () => {
    process.argv = [
      "bun",
      "vellum",
      "client",
      "--url",
      REMOTE_URL,
      "--token",
      "tok",
      "--assistant-id",
      "remote-xyz",
    ];
    const parsed = parseArgs();
    expect(parsed.assistantId).toBe("remote-xyz");
    expect(parsed.bearerToken).toBe("tok");
  });

  test("auto-opens the browser by default", () => {
    process.argv = [
      "bun",
      "vellum",
      "client",
      "--url",
      REMOTE_URL,
      "--token",
      "tok",
    ];
    expect(parseArgs().openBrowser).toBe(true);
  });

  test("--no-open opts out of auto-opening the browser", () => {
    process.argv = [
      "bun",
      "vellum",
      "client",
      "--url",
      REMOTE_URL,
      "--token",
      "tok",
      "--no-open",
    ];
    expect(parseArgs().openBrowser).toBe(false);
  });
});
