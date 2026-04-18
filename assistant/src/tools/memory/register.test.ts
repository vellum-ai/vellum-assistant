import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ToolContext } from "../types.js";

let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "remember-tool-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

// Import after the env var is set so getWorkspaceDir() resolves to the tmpdir.
const { rememberTool } = await import("./register.js");

function makeContext(): ToolContext {
  return {
    workingDir: tmpWorkspace,
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

describe("rememberTool.execute — finish_turn", () => {
  test("omits yieldToUser when finish_turn is not provided", async () => {
    const result = await rememberTool.execute(
      { content: "no finish_turn provided" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();
  });

  test("omits yieldToUser when finish_turn is false", async () => {
    const result = await rememberTool.execute(
      { content: "finish_turn=false", finish_turn: false },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBeUndefined();
  });

  test("sets yieldToUser=true when finish_turn is true", async () => {
    const result = await rememberTool.execute(
      { content: "finish_turn=true", finish_turn: true },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBe(true);
  });

  test("sets yieldToUser=true even when the write fails (empty content)", async () => {
    const result = await rememberTool.execute(
      { content: "", finish_turn: true },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.yieldToUser).toBe(true);
  });
});
