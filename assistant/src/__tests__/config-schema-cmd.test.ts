import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `vellum-schema-cmd-test-${randomBytes(4).toString("hex")}`,
);
const WORKSPACE_DIR = join(TEST_DIR, "workspace");
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    TEST_DIR,
    WORKSPACE_DIR,
    join(TEST_DIR, "data"),
    join(TEST_DIR, "memory"),
    join(TEST_DIR, "memory", "knowledge"),
    join(TEST_DIR, "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

ensureTestDir();

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
  getCliLogger: () => makeLoggerStub(),
}));

mock.module("../util/platform.js", () => ({
  getRootDir: () => TEST_DIR,
  getWorkspaceDir: () => WORKSPACE_DIR,
  getWorkspaceConfigPath: () => CONFIG_PATH,
  getDataDir: () => join(TEST_DIR, "data"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  ensureDataDir: () => ensureTestDir(),
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "anthropic-native" },
    },
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  syncConfigToLockfile: () => {},
}));

import { Command } from "commander";
import { z } from "zod";

import { registerConfigCommand } from "../cli/commands/config.js";
import { AssistantConfigSchema } from "../config/schema.js";
import { getSchemaAtPath } from "../config/schema-utils.js";

// ---------------------------------------------------------------------------
// Tests: getSchemaAtPath unit tests
// ---------------------------------------------------------------------------

describe("getSchemaAtPath", () => {
  test("returns full schema for a top-level key (maxTokens → number schema)", () => {
    const result = getSchemaAtPath(AssistantConfigSchema, "maxTokens");
    expect(result).not.toBeNull();
    // maxTokens has a default, so it should be parseable
    const parsed = (result as z.ZodType).parse(undefined);
    expect(parsed).toBe(16000);
  });

  test("navigates nested paths (memory.segmentation → object schema)", () => {
    const result = getSchemaAtPath(
      AssistantConfigSchema,
      "memory.segmentation",
    );
    expect(result).not.toBeNull();
    // Unwrap to check it has targetTokens and overlapTokens
    let schema: any = result;
    while (schema && !schema.shape) {
      const inner = schema._zod?.def?.innerType;
      if (!inner) break;
      schema = inner;
    }
    expect(schema.shape).toBeDefined();
    expect(schema.shape.targetTokens).toBeDefined();
    expect(schema.shape.overlapTokens).toBeDefined();
  });

  test("navigates through .default() wrappers (calls → object schema)", () => {
    const result = getSchemaAtPath(AssistantConfigSchema, "calls");
    expect(result).not.toBeNull();
    // Unwrap to check it has shape (it's a ZodDefault wrapping ZodObject)
    let schema: any = result;
    while (schema && !schema.shape) {
      const inner = schema._zod?.def?.innerType;
      if (!inner) break;
      schema = inner;
    }
    expect(schema.shape).toBeDefined();
    expect(schema.shape.enabled).toBeDefined();
    expect(schema.shape.voice).toBeDefined();
    expect(schema.shape.safety).toBeDefined();
  });

  test("returns null for non-existent top-level path", () => {
    const result = getSchemaAtPath(AssistantConfigSchema, "nonexistent");
    expect(result).toBeNull();
  });

  test("returns null for non-existent nested path", () => {
    const result = getSchemaAtPath(AssistantConfigSchema, "calls.nonexistent");
    expect(result).toBeNull();
  });

  test("returns null for path traversal through a leaf type", () => {
    // maxTokens is a number, not an object — can't traverse further
    const result = getSchemaAtPath(AssistantConfigSchema, "maxTokens.foo");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: z.toJSONSchema integration tests
// ---------------------------------------------------------------------------

describe("z.toJSONSchema integration", () => {
  test("full schema produces valid JSON Schema with type object and properties", () => {
    const jsonSchema = z.toJSONSchema(AssistantConfigSchema, {
      unrepresentable: "any",
    }) as Record<string, unknown>;
    expect(jsonSchema.type).toBe("object");
    const properties = jsonSchema.properties as Record<string, unknown>;
    expect(properties).toBeDefined();
    // Check that top-level keys are present
    expect(properties.services).toBeDefined();
    expect(properties.providerOrder).toBeDefined();
    expect(properties.maxTokens).toBeDefined();
    expect(properties.calls).toBeDefined();
    expect(properties.memory).toBeDefined();
    expect(properties.timeouts).toBeDefined();
    expect(properties.sandbox).toBeDefined();
  });

  test("sub-schema at calls produces JSON Schema with expected properties", () => {
    const callsSchema = getSchemaAtPath(AssistantConfigSchema, "calls");
    expect(callsSchema).not.toBeNull();
    const jsonSchema = z.toJSONSchema(callsSchema!, {
      unrepresentable: "any",
    }) as Record<string, unknown>;
    const properties = jsonSchema.properties as
      | Record<string, unknown>
      | undefined;
    expect(properties).toBeDefined();
    expect(properties!.enabled).toBeDefined();
    expect(properties!.voice).toBeDefined();
    expect(properties!.safety).toBeDefined();
  });

  test("sub-schema at a leaf like maxTokens produces integer schema", () => {
    const maxTokensSchema = getSchemaAtPath(AssistantConfigSchema, "maxTokens");
    expect(maxTokensSchema).not.toBeNull();
    const jsonSchema = z.toJSONSchema(maxTokensSchema!, {
      unrepresentable: "any",
    }) as Record<string, unknown>;
    expect(jsonSchema.type).toBe("integer");
  });

  test("sub-schema at memory.segmentation produces JSON Schema with expected properties", () => {
    const segSchema = getSchemaAtPath(
      AssistantConfigSchema,
      "memory.segmentation",
    );
    expect(segSchema).not.toBeNull();
    const jsonSchema = z.toJSONSchema(segSchema!, {
      unrepresentable: "any",
    }) as Record<string, unknown>;
    expect(jsonSchema.type).toBe("object");
    const properties = jsonSchema.properties as
      | Record<string, unknown>
      | undefined;
    expect(properties).toBeDefined();
    expect(properties!.targetTokens).toBeDefined();
    expect(properties!.overlapTokens).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: CLI schema command error path
// ---------------------------------------------------------------------------

describe("CLI schema command", () => {
  test("nonexistent path prints error and exits with code 1", () => {
    const program = new Command();
    program.exitOverride(); // throw instead of calling process.exit
    registerConfigCommand(program);

    const origExit = process.exit;
    // Replace process.exit to capture the exit code without killing the test
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;

    try {
      program.parse(["node", "test", "config", "schema", "nonexistent"]);
    } catch {
      // Expected: either Commander's exitOverride or our process.exit stub throws
    } finally {
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
  });
});
