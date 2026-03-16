import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, mock, spyOn, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing modules that use them
// ---------------------------------------------------------------------------

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "result" as const,
        session_id: "s",
        subtype: "success" as const,
        result: "ok",
      };
    },
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-2.5-flash-image",
      },
      "web-search": { mode: "your-own", provider: "anthropic-native" },
    },
  }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (name: string) =>
    name === "anthropic" ? "fake-anthropic-key" : null,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { claudeCodeTool } from "../tools/claude-code/claude-code.js";

// ---------------------------------------------------------------------------
// Locate the bundled skill directory relative to the test file
// ---------------------------------------------------------------------------

const SKILL_DIR = path.resolve(
  import.meta.dirname ?? __dirname,
  "../config/bundled-skills/claude-code",
);

const SHARED_DIR = path.resolve(
  import.meta.dirname ?? __dirname,
  "../config/bundled-skills/_shared",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Claude Code skill migration regression", () => {
  test("skill script wrapper exports a `run` function", async () => {
    const wrapperPath = path.join(SKILL_DIR, "tools/claude-code.ts");
    // The wrapper module must exist and export `run`
    const mod = await import(wrapperPath);
    expect(typeof mod.run).toBe("function");
  });

  test("TOOLS.json manifest lists claude_code as the tool name", () => {
    const manifestPath = path.join(SKILL_DIR, "TOOLS.json");
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);

    expect(manifest.version).toBe(1);
    expect(Array.isArray(manifest.tools)).toBe(true);

    const toolNames = manifest.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("claude_code");
  });

  test("TOOLS.json input_schema matches claudeCodeTool.getDefinition()", () => {
    const manifestPath = path.join(SKILL_DIR, "TOOLS.json");
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);

    const manifestTool = manifest.tools.find(
      (t: { name: string }) => t.name === "claude_code",
    );
    expect(manifestTool).toBeDefined();

    const runtimeDef = claudeCodeTool.getDefinition();

    // The input_schema declared in the static manifest must match the
    // runtime definition. Drift here would mean the model sees a different
    // schema than the executor actually supports.
    expect(manifestTool.input_schema).toEqual(runtimeDef.input_schema);
  });

  test("TOOLS.json description matches claudeCodeTool.getDefinition()", () => {
    const manifestPath = path.join(SKILL_DIR, "TOOLS.json");
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);

    const manifestTool = manifest.tools.find(
      (t: { name: string }) => t.name === "claude_code",
    );
    expect(manifestTool).toBeDefined();

    const runtimeDef = claudeCodeTool.getDefinition();

    // Description parity guards against a manifest edit that diverges from
    // the canonical tool description.
    expect(manifestTool.description).toBe(runtimeDef.description);
  });

  test("wrapper run() delegates to claudeCodeTool.execute()", async () => {
    // Verifies the wrapper is not a stale stub but actually calls through
    // to the canonical execute method with the exact input and context.
    const spy = spyOn(claudeCodeTool, "execute");

    const wrapperPath = path.join(SKILL_DIR, "tools/claude-code.ts");
    const mod = await import(wrapperPath);

    const input = { prompt: "hello" };
    const ctx = {
      conversationId: "test",
      workingDir: "/tmp",
      onOutput: () => {},
    };

    const result = await mod.run(input, ctx);
    expect(result.isError).toBeFalsy();

    // The wrapper must delegate to the canonical execute method
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(input, ctx);

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Bundled skill shared guidance — CES tools instead of token-reveal
// ---------------------------------------------------------------------------

describe("CLI_RETRIEVAL_PATTERN.md CES guidance", () => {
  const patternPath = path.join(SHARED_DIR, "CLI_RETRIEVAL_PATTERN.md");
  const content = fs.readFileSync(patternPath, "utf-8");

  test("teaches handle discovery via assistant credentials list", () => {
    expect(content).toContain("assistant credentials list");
  });

  test("teaches handle discovery via assistant oauth connections list", () => {
    expect(content).toContain("assistant oauth connections list");
  });

  test("teaches make_authenticated_request CES tool", () => {
    expect(content).toContain("make_authenticated_request");
  });

  test("teaches run_authenticated_command CES tool", () => {
    expect(content).toContain("run_authenticated_command");
  });

  test("warns that host_bash is outside CES secrecy boundary", () => {
    expect(content).toContain("outside the CES secrecy boundary");
  });

  // -- Deprecated patterns must NOT appear --

  test("does not teach proxied bash with credential_ids", () => {
    expect(content).not.toContain("credential_ids");
    expect(content).not.toContain("network_mode: proxied");
  });

  test("does not teach oauth connections token for raw token extraction", () => {
    expect(content).not.toContain("oauth connections token");
  });
});
