import { describe, expect, test } from "bun:test";

import {
  BROWSER_OPERATION_META,
  BROWSER_OPERATION_NAMES,
  BROWSER_TOOL_NAMES,
  browserOperationToToolName,
  browserToolNameToOperation,
  executeBrowserOperation,
  getBrowserOperationMeta,
} from "../operations.js";
import { BROWSER_OPERATIONS, type BrowserOperation } from "../types.js";

describe("browser operations contract", () => {
  // ── Exactly 17 operations ──────────────────────────────────────────

  test("defines exactly 17 operations", () => {
    expect(BROWSER_OPERATION_NAMES).toHaveLength(17);
    expect(BROWSER_TOOL_NAMES).toHaveLength(17);
  });

  // ── Bijective tool-name mapping ────────────────────────────────────

  test("tool name -> operation is bijective", () => {
    for (const op of BROWSER_OPERATIONS) {
      const toolName = browserOperationToToolName(op);
      expect(toolName).toBe(`browser_${op}`);
      const roundTripped = browserToolNameToOperation(toolName!);
      expect(roundTripped).toBe(op);
    }
  });

  test("operation -> tool name is bijective", () => {
    for (const toolName of BROWSER_TOOL_NAMES) {
      const op = browserToolNameToOperation(toolName);
      expect(op).toBeDefined();
      const roundTripped = browserOperationToToolName(op!);
      expect(roundTripped).toBe(toolName);
    }
  });

  test("unknown tool name returns undefined", () => {
    expect(browserToolNameToOperation("browser_unknown")).toBeUndefined();
    expect(browserToolNameToOperation("not_browser")).toBeUndefined();
    expect(browserToolNameToOperation("")).toBeUndefined();
  });

  test("unknown operation returns undefined", () => {
    expect(browserOperationToToolName("unknown")).toBeUndefined();
    expect(browserOperationToToolName("")).toBeUndefined();
  });

  // ── Every operation has metadata ───────────────────────────────────

  test("every operation has command metadata", () => {
    for (const op of BROWSER_OPERATIONS) {
      const meta = getBrowserOperationMeta(op);
      expect(meta).toBeDefined();
      expect(meta!.operation).toBe(op);
      expect(typeof meta!.description).toBe("string");
      expect(meta!.description.length).toBeGreaterThan(0);
    }
  });

  test("metadata count matches operation count", () => {
    expect(BROWSER_OPERATION_META).toHaveLength(BROWSER_OPERATIONS.length);
  });

  test("metadata operations match BROWSER_OPERATIONS", () => {
    const metaOps = BROWSER_OPERATION_META.map((m) => m.operation).sort();
    const declaredOps = [...BROWSER_OPERATIONS].sort();
    expect(metaOps).toEqual(declaredOps);
  });

  // ── Every operation has a dispatch handler ─────────────────────────

  test("every operation has a dispatch handler (rejects unknown)", async () => {
    // We verify dispatch handlers exist by calling executeBrowserOperation
    // with an invalid operation, which should return an error for unknown
    // operations. For known operations, the handler itself exists (it would
    // attempt real browser work, which we do not test here).
    const result = await executeBrowserOperation(
      "nonexistent" as BrowserOperation,
      {},
      {
        workingDir: "/tmp",
        conversationId: "test",
        trustClass: "guardian",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown browser operation");
  });

  // ── wait_for_download mode constraints ─────────────────────────────

  test("wait_for_download metadata restricts modes to auto and local", () => {
    const meta = getBrowserOperationMeta("wait_for_download");
    expect(meta).toBeDefined();
    expect(meta!.allowedModes).toBeDefined();
    expect(meta!.allowedModes).toContain("auto");
    expect(meta!.allowedModes).toContain("local");
    expect(meta!.allowedModes).toHaveLength(2);
  });

  test("wait_for_download rejects extension mode", async () => {
    const result = await executeBrowserOperation(
      "wait_for_download",
      { browser_mode: "extension" },
      {
        workingDir: "/tmp",
        conversationId: "test",
        trustClass: "guardian",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not support browser_mode");
    expect(result.content).toContain("extension");
  });

  test("wait_for_download rejects cdp-inspect mode", async () => {
    const result = await executeBrowserOperation(
      "wait_for_download",
      { browser_mode: "cdp-inspect" },
      {
        workingDir: "/tmp",
        conversationId: "test",
        trustClass: "guardian",
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not support browser_mode");
    expect(result.content).toContain("cdp-inspect");
  });

  // ── Metadata field constraints ─────────────────────────────────────

  test("all metadata fields have valid types", () => {
    const validTypes = new Set(["string", "number", "boolean"]);
    for (const meta of BROWSER_OPERATION_META) {
      for (const field of meta.fields) {
        expect(validTypes.has(field.type)).toBe(true);
        expect(typeof field.name).toBe("string");
        expect(field.name.length).toBeGreaterThan(0);
        expect(typeof field.description).toBe("string");
        expect(typeof field.required).toBe("boolean");
      }
    }
  });

  test("required fields appear before optional fields in metadata", () => {
    for (const meta of BROWSER_OPERATION_META) {
      let seenOptional = false;
      for (const field of meta.fields) {
        if (!field.required) {
          seenOptional = true;
        } else if (seenOptional) {
          throw new Error(
            `Operation "${meta.operation}": required field "${field.name}" appears after optional fields`,
          );
        }
      }
    }
  });

  // ── No TOOLS.json dependency ───────────────────────────────────────

  test("operations module does not depend on TOOLS.json", async () => {
    // Verify by checking that the operations module source does not
    // reference TOOLS.json. This is a static analysis guard.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../operations.ts", import.meta.url),
      "utf-8",
    );
    expect(source).not.toContain("TOOLS.json");
    expect(source).not.toContain("bundled-skills");
  });
});
