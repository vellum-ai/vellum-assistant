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

    const config = loadConfig();

    const written = readConfig() as { services?: Record<string, unknown> };
    expect(written.services).toBeDefined();
    // The existing value must be preserved — backfill path, not fresh-write path
    expect(
      (written.services!["inference"] as { mode?: string })?.mode,
    ).toBe("your-own");
    // ...and the in-memory config must mirror the explicit user choice (the
    // fill-defaults pass must not override an explicit "your-own").
    expect(
      (config.services.inference as { mode: string }).mode,
    ).toBe("your-own");
  });

  test("IS_PLATFORM=true, config file exists without a services key → in-memory config has all managed modes", () => {
    // Regression guard for the platform-managed boot order: by the time
    // `loadConfig()` runs, lifecycle steps such as `seedInferenceProfiles`
    // have already written `config.json` (with `llm.profiles` etc.), so
    // `configFileExisted` is true even on a brand-new platform-managed
    // assistant. Deployment-context defaults must still be applied to the
    // in-memory config for any leaf keys that are absent from disk.
    process.env.IS_PLATFORM = "true";

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          llm: {
            profiles: {
              balanced: { provider: "anthropic", model: "claude-sonnet-4.5" },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig();

    // In-memory config has the deployment-context defaults applied for the
    // missing service-mode fields.
    for (const svc of MANAGED_SERVICES) {
      expect(
        (
          config.services as unknown as Record<
            string,
            { mode: string }
          >
        )[svc]!.mode,
      ).toBe("managed");
    }

    // The on-disk file is NOT modified by the fill pass — disk reflects only
    // what was already there. Existing-file branch never re-writes config.json.
    const onDisk = readConfig() as Record<string, unknown>;
    expect(onDisk["services"]).toBeUndefined();
  });

  test("IS_PLATFORM=true, config file exists with a partial service subtree → preserves user fields, fills missing mode", () => {
    process.env.IS_PLATFORM = "true";

    // User has an image-generation provider configured but never explicitly
    // chose a mode for that service. The fill pass must apply
    // `mode: "managed"` without clobbering the user-supplied provider.
    // (The inference schema dropped per-service model/provider in
    // migration 039 — image-generation still carries them, so it's the
    // right schema to exercise the partial-subtree case.)
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          services: {
            "image-generation": { provider: "openai" },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig();

    const imageGen = (
      config.services as unknown as Record<
        string,
        { mode: string; provider?: string }
      >
    )["image-generation"]!;
    expect(imageGen.mode).toBe("managed");
    expect(imageGen.provider).toBe("openai");
  });

  test("IS_PLATFORM=false, config file exists without services key → in-memory config keeps schema your-own defaults", () => {
    // Sanity guard: deployment-context defaults are a no-op when IS_PLATFORM
    // is not enabled, regardless of whether config.json existed.
    process.env.IS_PLATFORM = "false";

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          llm: {
            profiles: {
              balanced: { provider: "anthropic", model: "claude-sonnet-4.5" },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig();

    for (const svc of MANAGED_SERVICES) {
      expect(
        (
          config.services as unknown as Record<
            string,
            { mode: string }
          >
        )[svc]!.mode,
      ).toBe("your-own");
    }
  });
});
