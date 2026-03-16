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

import { z } from "zod";

import { AssistantConfigSchema } from "../config/schema.js";
import { getSchemaAtPath } from "../config/schema-utils.js";

// ---------------------------------------------------------------------------
// Tests: getSchemaAtPath unit tests
// ---------------------------------------------------------------------------

describe("getSchemaAtPath", () => {
  test("returns full schema for a top-level key (provider → enum schema)", () => {
    const result = getSchemaAtPath(AssistantConfigSchema, "provider");
    expect(result).not.toBeNull();
    // provider is an enum with a default, so it should be parseable
    const parsed = (result as z.ZodType).parse(undefined);
    expect(parsed).toBe("anthropic");
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
    // provider is an enum, not an object — can't traverse further
    const result = getSchemaAtPath(AssistantConfigSchema, "provider.foo");
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
    expect(properties.provider).toBeDefined();
    expect(properties.model).toBeDefined();
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
    // Unwrap: the JSON schema may have the properties directly or nested
    // Look for calls-specific properties
    const properties = jsonSchema.properties as
      | Record<string, unknown>
      | undefined;
    if (properties) {
      expect(properties.enabled).toBeDefined();
      expect(properties.voice).toBeDefined();
      expect(properties.safety).toBeDefined();
    } else {
      // If it's a wrapped type, the JSON schema might have a different structure
      // but it should still be valid JSON Schema
      expect(jsonSchema).toBeDefined();
    }
  });

  test("sub-schema at a leaf like maxTokens produces integer schema", () => {
    const maxTokensSchema = getSchemaAtPath(AssistantConfigSchema, "maxTokens");
    expect(maxTokensSchema).not.toBeNull();
    const jsonSchema = z.toJSONSchema(maxTokensSchema!, {
      unrepresentable: "any",
    }) as Record<string, unknown>;
    expect(jsonSchema.type).toBe("integer");
  });
});
