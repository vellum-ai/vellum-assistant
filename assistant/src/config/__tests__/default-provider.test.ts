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

import { z } from "zod";

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
import { getSchemaAtPath } from "../schema-utils.js";
import { DefaultProviderSchema, LLMSchema } from "../schemas/llm.js";

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

  // Writes go through the strict `DefaultProviderSchema`, which rejects
  // invalid values loudly (the `.catch` on the field only applies when
  // reading persisted config).
  test("rejects an unknown provider", () => {
    expect(() =>
      DefaultProviderSchema.parse({ provider: "not-a-provider" }),
    ).toThrow();
  });

  test("rejects an empty connectionName", () => {
    expect(() =>
      DefaultProviderSchema.parse({
        provider: "anthropic",
        connectionName: "",
      }),
    ).toThrow();
  });

  test("rejects a missing provider", () => {
    expect(() =>
      DefaultProviderSchema.parse({ connectionName: "x" }),
    ).toThrow();
  });

  test("existing configs without the field still parse", () => {
    const parsed = LLMSchema.parse({});
    expect(parsed.defaultProvider).toBeUndefined();
  });

  // The loader's recovery pass deletes the exact key at each issue path and
  // re-parses, so a nested failure (invalid `provider` next to a valid
  // `connectionName`) would strand a `{ connectionName }` fragment that
  // fails the re-parse and escalates to a full config-defaults fallback.
  // The field's `.catch` avoids that entirely: an invalid value drops the
  // whole object at parse time and the surrounding config is untouched.
  test("an invalid defaultProvider is dropped atomically", () => {
    const result = LLMSchema.safeParse({
      profiles: { "my-profile": {} },
      activeProfile: "my-profile",
      defaultProvider: { provider: "not-a-provider", connectionName: "x" },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.defaultProvider).toBeUndefined();
    expect(result.data.activeProfile).toBe("my-profile");
  });

  test("a non-object defaultProvider is dropped, not fatal", () => {
    const result = LLMSchema.safeParse({ defaultProvider: "anthropic" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.defaultProvider).toBeUndefined();
  });

  // The config-schema API resolves dotted paths via `getSchemaAtPath` and
  // emits JSON Schema with `io: "input"`; both must see through the field's
  // wrappers to the object shape so clients can discover and validate it.
  test("schema introspection reaches the object shape and provider enum", () => {
    const atField = getSchemaAtPath(LLMSchema, "defaultProvider");
    expect(atField).not.toBeNull();
    const atProvider = getSchemaAtPath(LLMSchema, "defaultProvider.provider");
    expect(atProvider).not.toBeNull();
    expect(atProvider?.safeParse("anthropic").success).toBe(true);
    expect(atProvider?.safeParse("not-a-provider").success).toBe(false);
  });

  test("JSON Schema emission includes the field's object shape", () => {
    // Same options `handleGetConfigSchema` uses.
    const json = z.toJSONSchema(LLMSchema, {
      unrepresentable: "any",
      io: "input",
    }) as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const field = json.properties?.defaultProvider;
    expect(field?.properties?.provider).toBeDefined();
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
