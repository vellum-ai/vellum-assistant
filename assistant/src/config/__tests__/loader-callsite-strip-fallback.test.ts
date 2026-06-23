import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

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

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

afterAll(() => {
  mock.restore();
});

import { resolveCallSiteConfig } from "../llm-resolver.js";
import { invalidateConfigCache, loadConfig } from "../loader.js";

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * Base config where the active profile resolves to a DIFFERENT model than the
 * `balanced` profile that the shipped `memoryV3SelectL2` call-site default
 * points at. This lets each test distinguish the two failure modes:
 *   - call-site default applied (fixed)  -> model "balanced-model"
 *   - silently downgraded to active      -> model "active-model"
 */
function baseLlm(callSites: Record<string, unknown>): unknown {
  return {
    llm: {
      default: { provider: "anthropic", model: "default-model" },
      profiles: {
        balanced: { provider: "anthropic", model: "balanced-model" },
        speedy: { provider: "anthropic", model: "active-model" },
      },
      activeProfile: "speedy",
      callSites,
    },
  };
}

describe("config recovery prunes call-site overrides emptied by a strip", () => {
  beforeEach(() => {
    ensureTestDir();
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH, { force: true });
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.IS_PLATFORM;
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH, { force: true });
    invalidateConfigCache();
  });

  test("an undefined call-site profile ref falls back to the shipped default, not the active profile", () => {
    // The `.profile` ref is invalid (no such profile), so schema recovery
    // strips it. Before the fix this left `callSites.memoryV3SelectL2 = {}`,
    // which the resolver treats as a present override and so skips the shipped
    // `{profile:"balanced"}` default — silently resolving to the active profile.
    writeConfig(baseLlm({ memoryV3SelectL2: { profile: "ghost-profile" } }));

    const config = loadConfig();

    // The emptied call-site entry must be pruned entirely, not left as `{}`.
    expect(config.llm.callSites?.memoryV3SelectL2).toBeUndefined();

    // Resolution now lands on the shipped call-site default (balanced), not the
    // active profile ("active-model"), which is what the bug produced.
    const resolved = resolveCallSiteConfig("memoryV3SelectL2", config.llm);
    expect(resolved.model).toBe("balanced-model");
  });

  test("a valid sibling call-site override survives while the invalid one is pruned", () => {
    // memoryRouter -> balanced is valid and must be preserved; only the invalid
    // memoryV3SelectL2 entry is pruned. Guards against over-pruning the parent.
    writeConfig(
      baseLlm({
        memoryV3SelectL2: { profile: "missing" },
        memoryRouter: { profile: "balanced" },
      }),
    );

    const config = loadConfig();

    expect(config.llm.callSites?.memoryV3SelectL2).toBeUndefined();
    expect(config.llm.callSites?.memoryRouter).toEqual({ profile: "balanced" });
  });

  test("a partial override keeping other fields is not pruned", () => {
    // Stripping the invalid `.profile` leaves a non-empty `{temperature:0.5}`,
    // a legitimate user override the resolver should keep (and which therefore
    // still shadows the shipped default per existing either/or semantics).
    writeConfig(
      baseLlm({ memoryV3SelectL2: { profile: "missing", temperature: 0.5 } }),
    );

    const config = loadConfig();

    expect(config.llm.callSites?.memoryV3SelectL2).toEqual({
      temperature: 0.5,
    });
  });
});
