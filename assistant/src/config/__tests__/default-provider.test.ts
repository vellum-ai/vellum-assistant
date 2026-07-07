import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
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

import { VELLUM_MANAGED_CONNECTION_NAME } from "../../providers/vellum-model-routing.js";
import {
  getDefaultProvider,
  resolveDefaultConnectionName,
  setDefaultProvider,
} from "../default-provider.js";
import { invalidateConfigCache, loadRawConfig } from "../loader.js";
import { LLMSchema } from "../schemas/llm.js";

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

describe("LLMSchema.defaultProvider", () => {
  test("accepts a bare provider", () => {
    expect(() =>
      LLMSchema.parse({ defaultProvider: { provider: "anthropic" } }),
    ).not.toThrow();
  });

  test("accepts a provider pinned to a connection", () => {
    const parsed = LLMSchema.parse({
      defaultProvider: { provider: "vellum", connectionName: "x" },
    });
    expect(parsed.defaultProvider).toEqual({
      provider: "vellum",
      connectionName: "x",
    });
  });

  test("rejects an unknown provider", () => {
    expect(() =>
      LLMSchema.parse({ defaultProvider: { provider: "not-a-provider" } }),
    ).toThrow();
  });

  test("rejects an empty connectionName", () => {
    expect(() =>
      LLMSchema.parse({
        defaultProvider: { provider: "anthropic", connectionName: "" },
      }),
    ).toThrow();
  });

  test("rejects a missing provider", () => {
    expect(() =>
      LLMSchema.parse({ defaultProvider: { connectionName: "x" } }),
    ).toThrow();
  });

  test("existing configs without the field still parse", () => {
    const parsed = LLMSchema.parse({});
    expect(parsed.defaultProvider).toBeUndefined();
  });

  // The loader's recovery pass deletes the key at each issue path and
  // re-parses. Every defaultProvider failure must therefore be reported at
  // the `defaultProvider` path itself (never a nested leaf), so recovery
  // drops the whole object instead of leaving a fragment like
  // `{ connectionName }` that fails the re-parse and escalates to a full
  // config-defaults fallback.
  test("reports failures atomically at the defaultProvider path", () => {
    const result = LLMSchema.safeParse({
      profiles: {},
      defaultProvider: { provider: "not-a-provider", connectionName: "x" },
    });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const dpIssues = result.error.issues.filter(
      (i) => i.path[0] === "defaultProvider",
    );
    expect(dpIssues.length).toBeGreaterThan(0);
    for (const issue of dpIssues) {
      expect(issue.path).toEqual(["defaultProvider"]);
    }
  });

  test("recovery deleting defaultProvider yields a valid config", () => {
    const raw: Record<string, unknown> = {
      activeProfile: undefined,
      defaultProvider: { provider: "not-a-provider", connectionName: "x" },
    };
    const first = LLMSchema.safeParse(raw);
    expect(first.success).toBe(false);
    // Simulate the loader: delete the exact key at the issue path.
    delete raw.defaultProvider;
    const second = LLMSchema.safeParse(raw);
    expect(second.success).toBe(true);
  });
});

describe("resolveDefaultConnectionName", () => {
  test("an explicit pin wins", () => {
    expect(
      resolveDefaultConnectionName({
        provider: "anthropic",
        connectionName: "my-connection",
      }),
    ).toBe("my-connection");
  });

  test("vellum resolves to the managed connection name", () => {
    expect(resolveDefaultConnectionName({ provider: "vellum" })).toBe(
      VELLUM_MANAGED_CONNECTION_NAME,
    );
  });

  test("every other provider resolves to its personal connection", () => {
    expect(resolveDefaultConnectionName({ provider: "anthropic" })).toBe(
      "anthropic-personal",
    );
    expect(resolveDefaultConnectionName({ provider: "openai" })).toBe(
      "openai-personal",
    );
    expect(resolveDefaultConnectionName({ provider: "gemini" })).toBe(
      "gemini-personal",
    );
    expect(resolveDefaultConnectionName({ provider: "fireworks" })).toBe(
      "fireworks-personal",
    );
    expect(resolveDefaultConnectionName({ provider: "openrouter" })).toBe(
      "openrouter-personal",
    );
  });

  test("an explicit pin wins even for vellum", () => {
    expect(
      resolveDefaultConnectionName({
        provider: "vellum",
        connectionName: "pinned",
      }),
    ).toBe("pinned");
  });
});

describe("getDefaultProvider / setDefaultProvider", () => {
  beforeEach(() => {
    ensureTestDir();
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    invalidateConfigCache();
  });

  afterEach(() => {
    invalidateConfigCache();
  });

  test("getDefaultProvider returns null when absent", () => {
    expect(getDefaultProvider()).toBeNull();
  });

  test("set/get round-trip through the raw config", () => {
    setDefaultProvider({ provider: "openai", connectionName: "openai-work" });

    expect(getDefaultProvider()).toEqual({
      provider: "openai",
      connectionName: "openai-work",
    });

    const raw = loadRawConfig();
    const llm = raw.llm as Record<string, unknown>;
    expect(llm.defaultProvider).toEqual({
      provider: "openai",
      connectionName: "openai-work",
    });
  });

  test("setDefaultProvider validates the provider before writing", () => {
    expect(() =>
      setDefaultProvider({
        // @ts-expect-error deliberately invalid for the test
        provider: "not-a-provider",
      }),
    ).toThrow();
    expect(existsSync(CONFIG_PATH)).toBe(false);
  });

  test("getDefaultProvider accepts a pre-loaded config without re-reading disk", () => {
    setDefaultProvider({ provider: "gemini" });
    const config = { llm: { defaultProvider: { provider: "anthropic" } } };
    // @ts-expect-error partial AssistantConfig stub for the pure-read path
    expect(getDefaultProvider(config)).toEqual({ provider: "anthropic" });
  });

  test("writes invalidate the config cache so getConfigReadOnly sees the new value", () => {
    setDefaultProvider({ provider: "fireworks" });
    const after = readConfig();
    expect((after.llm as Record<string, unknown>).defaultProvider).toEqual({
      provider: "fireworks",
    });
  });
});
