/**
 * Tests for the workspace tool loader (workspace-tools/loader.ts).
 *
 * Each test gets its own per-pid+timestamp+counter tempdir so ESM import
 * caching cannot bleed between cases — bun caches dynamic-imported modules
 * by absolute URL, so two tests cannot reuse the same `<name>.ts` path and
 * still see fresh module evaluation.
 *
 * `VELLUM_WORKSPACE_DIR` is rewritten before each test so
 * `getWorkspaceToolsDir()` walks the isolated tree.
 *
 * Covers:
 * - Loading a well-formed workspace tool from `<name>.ts` adds a net-new entry.
 * - Loading a workspace tool whose name matches a core tool overrides it
 *   and stashes the original.
 * - `<name>.js` wins over `<name>.ts` (compiled-binary semantics) and the
 *   ignored extension is logged at warn.
 * - `<name>.json` loads as a declarative spec — execute defaults to an
 *   error result since JSON has no function type.
 * - `<name>.removed` strips a same-named core tool from the registry
 *   without substituting a replacement; restoring the file restores the
 *   core tool on next scan.
 * - A file whose import throws is logged + skipped without crashing.
 * - A missing `<workspaceDir>/tools/` directory is a no-op.
 * - A filename stem that fails `isProviderSafeToolName` is logged at error
 *   and skipped (no silent provider-safe rewrite — operator must rename).
 * - Multiple workspace tools register in a single batch.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import {
  __clearRegistryForTesting,
  getCoreToolOverride,
  getStrippedCoreToolNames,
  getTool,
  getToolOwner,
  getWorkspaceToolNames,
  registerTool,
} from "../tools/registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import {
  __resetWorkspaceToolCacheForTesting,
  loadWorkspaceTools,
} from "../tools/workspace-tools/loader.js";

// Per-test counter so each writeTool() call lands in a unique tempdir,
// defeating bun's per-URL ESM cache between tests. Without this, a
// second test that writes the same tool name would reuse the first
// test's already-evaluated module body.
let testCaseCounter = 0;
let currentWorkspaceDir: string;
const TEST_BASE_DIR = join(
  tmpdir(),
  `vellum-workspace-tool-loader-test-${process.pid}-${Date.now()}`,
);

function freshWorkspace(): string {
  testCaseCounter += 1;
  const dir = join(TEST_BASE_DIR, `case-${testCaseCounter}`);
  mkdirSync(dir, { recursive: true });
  process.env.VELLUM_WORKSPACE_DIR = dir;
  currentWorkspaceDir = dir;
  return dir;
}

/**
 * Materialize `<workspaceDir>/tools/<name>.<ext>` with the supplied body.
 * `ext` defaults to `.ts`; pass `.js` or `.json` to exercise the
 * extension precedence and JSON-spec paths.
 *
 * If the body does not include `export default` (for `.ts`/`.js`), the
 * test author is expected to know they're exercising a "missing default
 * export" path — the loader logs an error and skips the entry rather
 * than throwing.
 */
function writeTool(name: string, body: string, ext = ".ts"): void {
  const toolsDir = join(currentWorkspaceDir, "tools");
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, `${name}${ext}`), body);
}

/** Write a `<name>.removed` sentinel under `<workspaceDir>/tools/`. */
function writeRemovedSentinel(name: string): void {
  const toolsDir = join(currentWorkspaceDir, "tools");
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(toolsDir, `${name}.removed`), "");
}

/** Delete `<workspaceDir>/tools/<name><ext>` (defaults to `.ts`). */
function removeToolFile(name: string, ext = ".ts"): void {
  rmSync(join(currentWorkspaceDir, "tools", `${name}${ext}`), { force: true });
}

/**
 * Overwrite an existing tool file and bump its mtime into the future so the
 * reconcile's mtime gate re-imports it even when the rewrite lands within
 * the same millisecond as the original write.
 */
function rewriteTool(name: string, body: string, ext = ".ts"): void {
  const path = join(currentWorkspaceDir, "tools", `${name}${ext}`);
  writeFileSync(path, body);
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);
}

function makeFakeCoreTool(name: string): Tool {
  return {
    name,
    description: `Core ${name}`,
    category: "test",
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "sandbox",
    // Match the finalized shape the registry stores (defaults filled), so
    // `getCoreToolOverride(name)` toEqual comparisons hold after registration.
    exclusive: false,
    input_schema: { type: "object", properties: {}, required: [] },
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: "core", isError: false };
    },
  };
}

const WELL_FORMED_BODY = `
export default {
  description: "from workspace",
  defaultRiskLevel: "low",
  input_schema: {
    type: "object",
    properties: { greeting: { type: "string" } },
    required: [],
  },
  async execute() {
    return { content: "workspace-hello", isError: false };
  },
};
`;

const JS_BODY = `
export default {
  description: "from workspace js",
  defaultRiskLevel: "low",
  input_schema: { type: "object", properties: {}, required: [] },
  async execute() {
    return { content: "workspace-js", isError: false };
  },
};
`;

describe("workspace tool loader", () => {
  beforeEach(() => {
    __clearRegistryForTesting();
    __resetWorkspaceToolCacheForTesting();
    freshWorkspace();
  });

  afterAll(() => {
    rmSync(TEST_BASE_DIR, { recursive: true, force: true });
    delete process.env.VELLUM_WORKSPACE_DIR;
  });

  test("registers a net-new tool from <workspaceDir>/tools/<name>.ts", async () => {
    writeTool("hello_workspace", WELL_FORMED_BODY);

    await loadWorkspaceTools();

    const tool = getTool("hello_workspace");
    expect(tool).toBeDefined();
    expect(getToolOwner("hello_workspace")?.kind).toBe("workspace");
    expect(tool?.description).toBe("from workspace");
    expect(getWorkspaceToolNames()).toContain("hello_workspace");
    expect(getCoreToolOverride("hello_workspace")).toBeUndefined();
  });

  test("workspace tool with same name as core tool overrides and stashes the original", async () => {
    const core = makeFakeCoreTool("override_me");
    registerTool(core);

    writeTool("override_me", WELL_FORMED_BODY);

    await loadWorkspaceTools();

    const live = getTool("override_me");
    expect(live).toBeDefined();
    expect(getToolOwner("override_me")?.kind).toBe("workspace");
    expect(live?.description).toBe("from workspace");
    expect(getCoreToolOverride("override_me")).toEqual(core);
  });

  test(".js wins over .ts for the same stem (compiled-binary semantics)", async () => {
    writeTool("dual_ext", WELL_FORMED_BODY, ".ts");
    writeTool("dual_ext", JS_BODY, ".js");

    await loadWorkspaceTools();

    const tool = getTool("dual_ext");
    expect(tool).toBeDefined();
    // JS wins — body said "from workspace js"
    expect(tool?.description).toBe("from workspace js");
  });

  test(".json declarative spec loads with default error executor", async () => {
    writeTool(
      "data_only",
      JSON.stringify({
        description: "json spec",
        defaultRiskLevel: "low",
        input_schema: { type: "object", properties: {}, required: [] },
      }),
      ".json",
    );

    await loadWorkspaceTools();

    const tool = getTool("data_only");
    expect(tool).toBeDefined();
    expect(getToolOwner("data_only")?.kind).toBe("workspace");
    expect(tool?.description).toBe("json spec");
    // JSON specs always pick up the default error executor — calling
    // it returns isError=true with a "no execute implementation" message.
    const result = await tool!.execute(
      {},
      {} as unknown as Parameters<Tool["execute"]>[1],
    );
    expect(result.isError).toBe(true);
  });

  test(".removed sentinel strips a core tool from the registry", async () => {
    const core = makeFakeCoreTool("strip_me");
    registerTool(core);
    expect(getTool("strip_me")).toBeDefined();

    writeRemovedSentinel("strip_me");

    await loadWorkspaceTools();

    expect(getTool("strip_me")).toBeUndefined();
    expect(getStrippedCoreToolNames()).toContain("strip_me");
    // The stashed core tool is preserved for later restoration.
    expect(getCoreToolOverride("strip_me")).toEqual(core);
  });

  test(".removed sentinel for a non-existent name is a no-op", async () => {
    writeRemovedSentinel("never_was_a_tool");

    await loadWorkspaceTools();

    expect(getTool("never_was_a_tool")).toBeUndefined();
    expect(getStrippedCoreToolNames()).not.toContain("never_was_a_tool");
  });

  test("per-tool isolation: one bad tool does not block the rest", async () => {
    writeTool(
      "broken_at_import",
      `
throw new Error("boom at import time");
`,
    );
    writeTool("good_one", WELL_FORMED_BODY);

    await loadWorkspaceTools();

    expect(getTool("broken_at_import")).toBeUndefined();
    expect(getTool("good_one")).toBeDefined();
    expect(getToolOwner("good_one")?.kind).toBe("workspace");
  });

  test("missing default export logs + skips without crashing", async () => {
    writeTool(
      "no_default",
      `
export const named = { description: "wrong shape" };
`,
    );

    await loadWorkspaceTools();

    expect(getTool("no_default")).toBeUndefined();
  });

  test("non-object default export logs + skips without crashing", async () => {
    writeTool(
      "wrong_type",
      `
export default 42;
`,
    );

    await loadWorkspaceTools();

    expect(getTool("wrong_type")).toBeUndefined();
  });

  test("no <workspaceDir>/tools/ directory is a no-op", async () => {
    // `freshWorkspace()` does not create a tools/ dir — the loader must
    // complete without throwing and register nothing.
    await loadWorkspaceTools();

    expect(getWorkspaceToolNames()).toEqual([]);
  });

  test("filename stems that fail provider-safe validation are skipped", async () => {
    // Provider-safe names match /^[a-zA-Z0-9_-]{1,64}$/. A stem with a
    // space embeds an LLM-provider-incompatible character. The loader
    // refuses to rewrite the name (which would produce an unfindable
    // hash suffix); the operator must rename the file.
    const toolsDir = join(currentWorkspaceDir, "tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, "has space.ts"), WELL_FORMED_BODY);

    await loadWorkspaceTools();

    expect(getWorkspaceToolNames()).toEqual([]);
  });

  test("dotfile stems (starting with .) are excluded", async () => {
    // `.gitignore`, `.DS_Store`, etc. must not register as tools.
    const toolsDir = join(currentWorkspaceDir, "tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, ".gitignore"), "node_modules");

    await loadWorkspaceTools();

    expect(getWorkspaceToolNames()).toEqual([]);
  });

  test("multiple tools register in a single batch", async () => {
    writeTool("alpha", WELL_FORMED_BODY);
    writeTool("beta", WELL_FORMED_BODY);
    writeTool("gamma", WELL_FORMED_BODY);

    await loadWorkspaceTools();

    const names = getWorkspaceToolNames().sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });

  // ── Reconcile-on-read behavior ─────────────────────────────────────────
  //
  // loadWorkspaceTools() is idempotent and re-derives registry state from
  // disk on every call. These cases cover the deltas a repeat call applies,
  // which is what replaces the old filesystem watcher.

  test("repeat call with no disk changes is a no-op (does not throw or duplicate)", async () => {
    writeTool("stable_tool", WELL_FORMED_BODY);

    await loadWorkspaceTools();
    // A second reconcile must not throw on the already-registered name —
    // the mtime cache recognizes the unchanged file and skips re-import.
    await loadWorkspaceTools();

    expect(getTool("stable_tool")).toBeDefined();
    expect(getWorkspaceToolNames()).toEqual(["stable_tool"]);
  });

  test("a file added after the first reconcile registers on the next", async () => {
    writeTool("first", WELL_FORMED_BODY);
    await loadWorkspaceTools();
    expect(getWorkspaceToolNames()).toEqual(["first"]);

    writeTool("second", WELL_FORMED_BODY);
    await loadWorkspaceTools();

    expect(getWorkspaceToolNames().sort()).toEqual(["first", "second"]);
  });

  test("a changed file is re-imported on the next reconcile", async () => {
    writeTool("mutable", WELL_FORMED_BODY);
    await loadWorkspaceTools();
    expect(getTool("mutable")?.description).toBe("from workspace");

    rewriteTool(
      "mutable",
      `
export default {
  description: "edited in place",
  defaultRiskLevel: "low",
  input_schema: { type: "object", properties: {}, required: [] },
  async execute() {
    return { content: "edited", isError: false };
  },
};
`,
    );
    await loadWorkspaceTools();

    expect(getTool("mutable")?.description).toBe("edited in place");
  });

  test("a deleted net-new tool file is unregistered on the next reconcile", async () => {
    writeTool("ephemeral", WELL_FORMED_BODY);
    await loadWorkspaceTools();
    expect(getTool("ephemeral")).toBeDefined();

    removeToolFile("ephemeral");
    await loadWorkspaceTools();

    expect(getTool("ephemeral")).toBeUndefined();
    expect(getWorkspaceToolNames()).toEqual([]);
  });

  test("deleting an override file restores the stashed core tool", async () => {
    const core = makeFakeCoreTool("restore_me");
    registerTool(core);
    writeTool("restore_me", WELL_FORMED_BODY);

    await loadWorkspaceTools();
    expect(getToolOwner("restore_me")?.kind).toBe("workspace");

    removeToolFile("restore_me");
    await loadWorkspaceTools();

    // The stashed built-in is restored with its `default` owner.
    expect(getToolOwner("restore_me")).toEqual({
      kind: "default",
      id: "default",
    });
    expect(getTool("restore_me")).toEqual(core);
    expect(getCoreToolOverride("restore_me")).toBeUndefined();
  });

  test("deleting a .removed sentinel restores the stripped core tool", async () => {
    const core = makeFakeCoreTool("strip_then_restore");
    registerTool(core);
    writeRemovedSentinel("strip_then_restore");

    await loadWorkspaceTools();
    expect(getTool("strip_then_restore")).toBeUndefined();
    expect(getStrippedCoreToolNames()).toContain("strip_then_restore");

    removeToolFile("strip_then_restore", ".removed");
    await loadWorkspaceTools();

    expect(getTool("strip_then_restore")).toEqual(core);
    expect(getStrippedCoreToolNames()).not.toContain("strip_then_restore");
  });

  test("the registered name is the filename stem, ignoring the file's own name field", async () => {
    // The default export sets a different `name` — the loader must pin the
    // registered name to the stem ("stem_wins") so the mtime cache and the
    // unregister-on-delete path stay keyed by the same name.
    writeTool(
      "stem_wins",
      `
export default {
  name: "different_name",
  description: "name field should be ignored",
  defaultRiskLevel: "low",
  input_schema: { type: "object", properties: {}, required: [] },
  async execute() {
    return { content: "ok", isError: false };
  },
};
`,
    );

    await loadWorkspaceTools();

    expect(getTool("stem_wins")).toBeDefined();
    expect(getTool("different_name")).toBeUndefined();
    expect(getWorkspaceToolNames()).toEqual(["stem_wins"]);

    // Deleting the file unregisters by stem — no leaked "different_name".
    removeToolFile("stem_wins");
    await loadWorkspaceTools();
    expect(getTool("stem_wins")).toBeUndefined();
    expect(getTool("different_name")).toBeUndefined();
  });

  test("per-tool isolation on reconcile: a bad file does not drop a valid edited tool", async () => {
    writeTool("good_edit", WELL_FORMED_BODY);
    await loadWorkspaceTools();
    expect(getTool("good_edit")?.description).toBe("from workspace");

    // Add a file that throws at import, and edit the good tool, in the same
    // reconcile. The broken file must not prevent the edited tool from
    // re-registering.
    writeTool("broken_now", `throw new Error("boom at import");`);
    rewriteTool(
      "good_edit",
      `
export default {
  description: "edited and still here",
  defaultRiskLevel: "low",
  input_schema: { type: "object", properties: {}, required: [] },
  async execute() {
    return { content: "ok", isError: false };
  },
};
`,
    );
    await loadWorkspaceTools();

    expect(getTool("broken_now")).toBeUndefined();
    expect(getTool("good_edit")?.description).toBe("edited and still here");
  });

  test("an edit that breaks an existing tool keeps the prior registration", async () => {
    writeTool("was_good", WELL_FORMED_BODY);
    await loadWorkspaceTools();
    expect(getTool("was_good")?.description).toBe("from workspace");

    // Rewrite the file into something that throws at import. The prior,
    // working registration must stay in place rather than being torn down.
    rewriteTool("was_good", `throw new Error("now broken");`);
    await loadWorkspaceTools();

    expect(getTool("was_good")?.description).toBe("from workspace");
  });
});
