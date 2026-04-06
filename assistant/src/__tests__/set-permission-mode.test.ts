/**
 * Tests for the set_permission_mode system tool.
 *
 * Verifies:
 *   - Mode transitions via askBeforeActing and hostAccess
 *   - Partial updates (only provided fields change)
 *   - Idempotent calls (setting same value is safe)
 *   - Error when no fields provided
 *   - Tool is not registered when permission-controls-v2 flag is off
 *   - Tool is registered when permission-controls-v2 flag is on
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
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

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

afterAll(() => {
  mock.restore();
});

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import { invalidateConfigCache } from "../config/loader.js";
import {
  getMode,
  resetForTesting,
} from "../permissions/permission-mode-store.js";
import { __clearRegistryForTesting, getTool } from "../tools/registry.js";
import { registerSystemTools } from "../tools/system/register.js";
import { setPermissionModeTool } from "../tools/system/set-permission-mode.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  ensureTestDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function makeContext(): ToolContext {
  return {
    workingDir: WORKSPACE_DIR,
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  ensureTestDir();
  resetForTesting();
  invalidateConfigCache();
  _setOverridesForTesting({});
  __clearRegistryForTesting();
  // Write a minimal config so the store initializes cleanly
  writeConfig({});
});

afterEach(() => {
  resetForTesting();
  invalidateConfigCache();
  _setOverridesForTesting({});
  __clearRegistryForTesting();
});

// ---------------------------------------------------------------------------
// Tests — tool execution
// ---------------------------------------------------------------------------

describe("set_permission_mode tool", () => {
  describe("mode transitions", () => {
    test("sets askBeforeActing to false", async () => {
      const result = await setPermissionModeTool.execute(
        { askBeforeActing: false },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("askBeforeActing: false");

      const mode = getMode();
      expect(mode.askBeforeActing).toBe(false);
    });

    test("sets hostAccess to true", async () => {
      const result = await setPermissionModeTool.execute(
        { hostAccess: true },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("hostAccess: true");

      const mode = getMode();
      expect(mode.hostAccess).toBe(true);
    });

    test("sets both fields at once", async () => {
      const result = await setPermissionModeTool.execute(
        { askBeforeActing: false, hostAccess: true },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("askBeforeActing: false");
      expect(result.content).toContain("hostAccess: true");

      const mode = getMode();
      expect(mode.askBeforeActing).toBe(false);
      expect(mode.hostAccess).toBe(true);
    });
  });

  describe("partial updates", () => {
    test("only askBeforeActing changes, hostAccess unchanged", async () => {
      await setPermissionModeTool.execute(
        { askBeforeActing: false },
        makeContext(),
      );

      const mode = getMode();
      expect(mode.askBeforeActing).toBe(false);
      // hostAccess should remain at default (false)
      expect(mode.hostAccess).toBe(false);
    });

    test("only hostAccess changes, askBeforeActing unchanged", async () => {
      await setPermissionModeTool.execute({ hostAccess: true }, makeContext());

      const mode = getMode();
      // askBeforeActing should remain at default (true)
      expect(mode.askBeforeActing).toBe(true);
      expect(mode.hostAccess).toBe(true);
    });
  });

  describe("idempotent calls", () => {
    test("setting askBeforeActing to current value is safe", async () => {
      // Default is true
      const result = await setPermissionModeTool.execute(
        { askBeforeActing: true },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(getMode().askBeforeActing).toBe(true);
    });

    test("setting hostAccess to current value is safe", async () => {
      // Default is false
      const result = await setPermissionModeTool.execute(
        { hostAccess: false },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(getMode().hostAccess).toBe(false);
    });

    test("repeated calls produce same result", async () => {
      await setPermissionModeTool.execute(
        { askBeforeActing: false, hostAccess: true },
        makeContext(),
      );
      const result = await setPermissionModeTool.execute(
        { askBeforeActing: false, hostAccess: true },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      const mode = getMode();
      expect(mode.askBeforeActing).toBe(false);
      expect(mode.hostAccess).toBe(true);
    });
  });

  describe("validation", () => {
    test("returns error when no fields provided", async () => {
      const result = await setPermissionModeTool.execute({}, makeContext());

      expect(result.isError).toBe(true);
      expect(result.content).toContain("at least one");
    });
  });

  describe("tool definition", () => {
    test("has correct name", () => {
      expect(setPermissionModeTool.name).toBe("set_permission_mode");
    });

    test("has correct category", () => {
      expect(setPermissionModeTool.category).toBe("system");
    });

    test("definition includes both properties", () => {
      const def = setPermissionModeTool.getDefinition();
      const schema = def.input_schema as { properties?: Record<string, unknown> };
      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("askBeforeActing");
      expect(props).toHaveProperty("hostAccess");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — feature flag gating
// ---------------------------------------------------------------------------

describe("set_permission_mode registration", () => {
  test("tool is NOT registered when permission-controls-v2 flag is off", () => {
    _setOverridesForTesting({ "permission-controls-v2": false });
    registerSystemTools();

    expect(getTool("set_permission_mode")).toBeUndefined();
  });

  test("tool IS registered when permission-controls-v2 flag is on", () => {
    _setOverridesForTesting({ "permission-controls-v2": true });
    registerSystemTools();

    expect(getTool("set_permission_mode")).toBeDefined();
  });
});
