import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { BROWSER_OPERATIONS } from "../../../../../browser/types.js";

const TOOLS_DIR = join(import.meta.dir, "..");

describe("browser skill wrappers are thin adapters", () => {
  // Collect all browser-*.ts wrapper files (excluding shared.ts and test dirs).
  const wrapperFiles = readdirSync(TOOLS_DIR)
    .filter((f) => f.startsWith("browser-") && f.endsWith(".ts"))
    .sort();

  test("has exactly 17 wrapper files matching BROWSER_OPERATIONS", () => {
    expect(wrapperFiles).toHaveLength(17);
    expect(wrapperFiles).toHaveLength(BROWSER_OPERATIONS.length);
  });

  test("every wrapper file maps to a valid browser_* tool name", () => {
    for (const file of wrapperFiles) {
      // browser-navigate.ts -> browser_navigate
      const toolName = file.replace(".ts", "").replace(/-/g, "_");
      const operation = toolName.replace("browser_", "");
      expect(
        (BROWSER_OPERATIONS as readonly string[]).includes(operation),
      ).toBe(true);
    }
  });

  test("every wrapper delegates through shared.ts runBrowserTool", () => {
    for (const file of wrapperFiles) {
      const source = readFileSync(join(TOOLS_DIR, file), "utf-8");
      // Wrapper must import from shared.ts
      expect(source).toContain("./shared.js");
      expect(source).toContain("runBrowserTool");
    }
  });

  test("no wrapper imports browser-execution, browser-manager, or browser-mode directly", () => {
    for (const file of wrapperFiles) {
      const source = readFileSync(join(TOOLS_DIR, file), "utf-8");
      expect(source).not.toContain("browser-execution");
      expect(source).not.toContain("browser-manager");
      expect(source).not.toContain("browser-mode");
    }
  });

  test("shared.ts exists and exports runBrowserTool", () => {
    const sharedSource = readFileSync(join(TOOLS_DIR, "shared.ts"), "utf-8");
    expect(sharedSource).toContain("export async function runBrowserTool");
    expect(sharedSource).toContain("browserToolNameToOperation");
    expect(sharedSource).toContain("executeBrowserOperation");
  });

  test("shared.ts does not depend on TOOLS.json or bundled-skills internals", () => {
    const sharedSource = readFileSync(join(TOOLS_DIR, "shared.ts"), "utf-8");
    expect(sharedSource).not.toContain("TOOLS.json");
  });

  test("each wrapper passes the correct tool name to runBrowserTool", () => {
    for (const file of wrapperFiles) {
      const toolName = file.replace(".ts", "").replace(/-/g, "_");
      const source = readFileSync(join(TOOLS_DIR, file), "utf-8");
      expect(source).toContain(`"${toolName}"`);
    }
  });
});
