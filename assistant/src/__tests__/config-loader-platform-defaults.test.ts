/**
 * When IS_PLATFORM=true and no config.json exists yet, loadConfig() must
 * write all eight managed-capable service modes as "managed" instead of the
 * schema default "your-own". When IS_PLATFORM is absent/false, or when
 * config.json already exists, the schema defaults and existing values are
 * preserved unchanged.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

afterAll(() => {
  mock.restore();
});

import { invalidateConfigCache, loadConfig } from "../config/loader.js";
import { _setStorePath } from "../security/encrypted-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "memory", "knowledge"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function resetWorkspace(): void {
  if (existsSync(WORKSPACE_DIR)) {
    for (const name of readdirSync(WORKSPACE_DIR)) {
      rmSync(join(WORKSPACE_DIR, name), { recursive: true, force: true });
    }
  }
  ensureTestDir();
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

const MANAGED_SERVICES = [
  "inference",
  "image-generation",
  "web-search",
  "google-oauth",
  "outlook-oauth",
  "linear-oauth",
  "github-oauth",
  "notion-oauth",
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("platform-managed config defaults", () => {
  const originalIsPlatform = process.env.IS_PLATFORM;

  beforeEach(() => {
    resetWorkspace();
    _setStorePath(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    _setStorePath(null);
    invalidateConfigCache();
    // Restore env to its original value
    if (originalIsPlatform === undefined) {
      delete process.env.IS_PLATFORM;
    } else {
      process.env.IS_PLATFORM = originalIsPlatform;
    }
  });

  test("IS_PLATFORM=true, no config file → all 8 service modes written as 'managed'", () => {
    process.env.IS_PLATFORM = "true";

    loadConfig();

    expect(existsSync(CONFIG_PATH)).toBe(true);
    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    const services = written.services!;
    for (const svc of MANAGED_SERVICES) {
      expect((services[svc] as { mode?: string })?.mode).toBe("managed");
    }
  });

  test("IS_PLATFORM=false, no config file → service modes default to 'your-own'", () => {
    process.env.IS_PLATFORM = "false";

    loadConfig();

    expect(existsSync(CONFIG_PATH)).toBe(true);
    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    const services = written.services!;
    for (const svc of MANAGED_SERVICES) {
      expect((services[svc] as { mode?: string })?.mode).toBe("your-own");
    }
  });

  test("IS_PLATFORM unset, no config file → service modes default to 'your-own'", () => {
    delete process.env.IS_PLATFORM;

    loadConfig();

    expect(existsSync(CONFIG_PATH)).toBe(true);
    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    const services = written.services!;
    for (const svc of MANAGED_SERVICES) {
      expect((services[svc] as { mode?: string })?.mode).toBe("your-own");
    }
  });

  test("IS_PLATFORM=true, config file already exists → existing service mode values are preserved", () => {
    process.env.IS_PLATFORM = "true";

    // Write an existing config with inference mode explicitly set to "your-own"
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          services: {
            inference: { mode: "your-own" },
          },
        },
        null,
        2,
      ) + "\n",
    );

    loadConfig();

    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    // The existing value must be preserved — backfill path, not fresh-write path
    expect(
      (written.services!["inference"] as { mode?: string })?.mode,
    ).toBe("your-own");
  });
});
