/**
 * Tests for the `toolResultTruncate` plugin pipeline (PR 17).
 *
 * Covers:
 * - The default terminal delegates to `truncateToolResultText`, producing
 *   byte-for-byte identical output to calling the helper directly across
 *   short, long, and newline-bounded inputs (property-style).
 * - The pipeline routes through `runPipeline` with the
 *   `DEFAULT_TIMEOUTS.toolResultTruncate` budget and returns a
 *   `{ content, truncated }` pair whose `truncated` flag matches whether
 *   the content actually changed.
 * - Plugins registered alongside the default can short-circuit or decorate
 *   the terminal's output.
 * - A user plugin registered AFTER the default still runs — the default
 *   plugin's middleware is a passthrough, so the onion composition cannot
 *   shadow late-registered middleware.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  MIN_KEEP_CHARS,
  truncateToolResultText,
  TRUNCATION_SUFFIX,
} from "../context/tool-result-truncation.js";
import type { TrustContext } from "../daemon/trust-context.js";
import {
  defaultToolResultTruncatePlugin,
  defaultToolResultTruncateTerminal,
} from "../plugins/defaults/tool-result-truncate.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  type Middleware,
  type ToolResultTruncateArgs,
  type ToolResultTruncateResult,
  type TurnContext,
} from "../plugins/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust,
    ...overrides,
  };
}

describe("toolResultTruncate pipeline", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  // -------------------------------------------------------------------------
  // Default terminal — isolated (no pipeline runner)
  // -------------------------------------------------------------------------

  describe("default terminal", () => {
    test("passes short content through unchanged with truncated=false", () => {
      const content = "hello world";
      const result = defaultToolResultTruncateTerminal({
        content,
        maxChars: 100,
      });
      expect(result.content).toBe(content);
      expect(result.truncated).toBe(false);
    });

    test("truncates oversize content and reports truncated=true", () => {
      const content = "a".repeat(10_000);
      const maxChars = 5_000;
      const expected = truncateToolResultText(content, maxChars);
      const result = defaultToolResultTruncateTerminal({ content, maxChars });
      expect(result.content).toBe(expected);
      expect(result.truncated).toBe(true);
      expect(result.content).toContain(TRUNCATION_SUFFIX);
    });

    test("snaps to newline boundary identically to truncateToolResultText", () => {
      const lines = Array.from(
        { length: 1_000 },
        (_, i) => `line ${i}: ${"x".repeat(20)}`,
      ).join("\n");
      const maxChars = 5_000;
      const expected = truncateToolResultText(lines, maxChars);
      const result = defaultToolResultTruncateTerminal({
        content: lines,
        maxChars,
      });
      expect(result.content).toBe(expected);
      expect(result.truncated).toBe(true);
    });

    test("returns truncated=false when effectiveMax keeps the full text (maxChars < MIN_KEEP_CHARS case)", () => {
      const textLength = MIN_KEEP_CHARS - TRUNCATION_SUFFIX.length - 10;
      const content = "a".repeat(textLength);
      const maxChars = 100;
      const expected = truncateToolResultText(content, maxChars);
      const result = defaultToolResultTruncateTerminal({ content, maxChars });
      // Helper returns the original text unchanged in this case.
      expect(expected).toBe(content);
      expect(result.content).toBe(content);
      expect(result.truncated).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end: default plugin routed through runPipeline
  // -------------------------------------------------------------------------

  describe("runPipeline with the default plugin registered", () => {
    async function runDefault(
      content: string,
      maxChars: number,
    ): Promise<ToolResultTruncateResult> {
      registerPlugin(defaultToolResultTruncatePlugin);
      const middlewares = getMiddlewaresFor("toolResultTruncate");
      return runPipeline<ToolResultTruncateArgs, ToolResultTruncateResult>(
        "toolResultTruncate",
        middlewares,
        async (args) => defaultToolResultTruncateTerminal(args),
        { content, maxChars },
        makeCtx(),
        DEFAULT_TIMEOUTS.toolResultTruncate,
      );
    }

    test("short content round-trip matches truncateToolResultText", async () => {
      const content = "quick brown fox";
      const maxChars = 200;
      const expected = truncateToolResultText(content, maxChars);
      const result = await runDefault(content, maxChars);
      expect(result.content).toBe(expected);
      expect(result.truncated).toBe(false);
    });

    test("long content round-trip matches truncateToolResultText", async () => {
      const content = "z".repeat(50_000);
      const maxChars = 10_000;
      const expected = truncateToolResultText(content, maxChars);
      const result = await runDefault(content, maxChars);
      expect(result.content).toBe(expected);
      expect(result.truncated).toBe(true);
      expect(result.content).toContain(TRUNCATION_SUFFIX);
    });

    test("newline-bounded content round-trip matches truncateToolResultText", async () => {
      const lines = Array.from(
        { length: 500 },
        (_, i) => `line ${i}: ${"y".repeat(40)}`,
      ).join("\n");
      const maxChars = 4_000;
      const expected = truncateToolResultText(lines, maxChars);
      const result = await runDefault(lines, maxChars);
      expect(result.content).toBe(expected);
      expect(result.truncated).toBe(true);
    });

    test("property test: default pipeline output equals direct truncateToolResultText across varied inputs", async () => {
      // Deterministic pseudo-random over a fixed seed — bun's test runner
      // doesn't ship a property-test library, so we hand-roll a tiny LCG
      // that produces enough spread for a meaningful regression signal
      // without introducing a dependency.
      let seed = 0xc0ffee;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) & 0xffffffff;
        return (seed >>> 0) / 0x100000000;
      };
      const alphabet = "abcdefghijklmnopqrstuvwxyz \n";

      const cases: Array<{ content: string; maxChars: number }> = [];
      for (let i = 0; i < 40; i++) {
        // Lengths span short, boundary, and long relative to the maxChars
        // budget so the property covers pass-through, newline-snap, and
        // pure tail-drop paths.
        const length = Math.floor(rand() * 20_000);
        let content = "";
        for (let j = 0; j < length; j++) {
          content += alphabet[Math.floor(rand() * alphabet.length)];
        }
        const maxChars = 1_000 + Math.floor(rand() * 9_000);
        cases.push({ content, maxChars });
      }

      // Register once outside the loop — registry is reset in `beforeEach`,
      // so the per-case reset lives in the loop instead.
      for (const { content, maxChars } of cases) {
        resetPluginRegistryForTests();
        registerPlugin(defaultToolResultTruncatePlugin);
        const middlewares = getMiddlewaresFor("toolResultTruncate");
        const result = await runPipeline<
          ToolResultTruncateArgs,
          ToolResultTruncateResult
        >(
          "toolResultTruncate",
          middlewares,
          async (args) => defaultToolResultTruncateTerminal(args),
          { content, maxChars },
          makeCtx(),
          DEFAULT_TIMEOUTS.toolResultTruncate,
        );
        const expected = truncateToolResultText(content, maxChars);
        expect(result.content).toBe(expected);
        expect(result.truncated).toBe(expected !== content);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Middleware composition — an outer plugin can intercept / transform
  // -------------------------------------------------------------------------

  describe("middleware composition", () => {
    test("an outer plugin can short-circuit the default with its own content", async () => {
      const shortCircuit: Middleware<
        ToolResultTruncateArgs,
        ToolResultTruncateResult
      > = async (_args, _next, _ctx) => {
        return { content: "SUMMARY", truncated: true };
      };
      registerPlugin({
        manifest: {
          name: "short-circuit",
          version: "1.0.0",
          requires: {
            pluginRuntime: "v1",
            toolResultTruncateApi: "v1",
          },
        },
        middleware: { toolResultTruncate: shortCircuit },
      });
      registerPlugin(defaultToolResultTruncatePlugin);

      const middlewares = getMiddlewaresFor("toolResultTruncate");
      const result = await runPipeline<
        ToolResultTruncateArgs,
        ToolResultTruncateResult
      >(
        "toolResultTruncate",
        middlewares,
        async (args) => defaultToolResultTruncateTerminal(args),
        { content: "a".repeat(10_000), maxChars: 5_000 },
        makeCtx(),
        DEFAULT_TIMEOUTS.toolResultTruncate,
      );

      expect(result.content).toBe("SUMMARY");
      expect(result.truncated).toBe(true);
    });

    test("an outer plugin can observe and mutate the default's output", async () => {
      const prefixer: Middleware<
        ToolResultTruncateArgs,
        ToolResultTruncateResult
      > = async (args, next, _ctx) => {
        const inner = await next(args);
        return { ...inner, content: `[wrapped] ${inner.content}` };
      };
      registerPlugin({
        manifest: {
          name: "prefixer",
          version: "1.0.0",
          requires: {
            pluginRuntime: "v1",
            toolResultTruncateApi: "v1",
          },
        },
        middleware: { toolResultTruncate: prefixer },
      });
      registerPlugin(defaultToolResultTruncatePlugin);

      const middlewares = getMiddlewaresFor("toolResultTruncate");
      const content = "hello";
      const result = await runPipeline<
        ToolResultTruncateArgs,
        ToolResultTruncateResult
      >(
        "toolResultTruncate",
        middlewares,
        async (args) => defaultToolResultTruncateTerminal(args),
        { content, maxChars: 100 },
        makeCtx(),
        DEFAULT_TIMEOUTS.toolResultTruncate,
      );

      expect(result.content).toBe(`[wrapped] ${content}`);
      expect(result.truncated).toBe(false);
    });

    test("user plugin registered AFTER the default still runs (no shadowing)", async () => {
      // Production registration order: defaults load first via the
      // side-effect imports in `defaults/index.ts`, then user plugins
      // register on top (via `bootstrapPlugins()` or hot-reload). The
      // user's middleware ends up at a deeper onion layer than the
      // default. If the default's middleware were to bypass `next` and
      // call the terminal directly, the user middleware would never run
      // — this test guards against that regression.
      registerPlugin(defaultToolResultTruncatePlugin);

      let userMiddlewareRan = false;
      const userMiddleware: Middleware<
        ToolResultTruncateArgs,
        ToolResultTruncateResult
      > = async (args, next) => {
        userMiddlewareRan = true;
        return next(args);
      };
      registerPlugin({
        manifest: {
          name: "late-user-plugin",
          version: "0.0.1",
          requires: {
            pluginRuntime: "v1",
            toolResultTruncateApi: "v1",
          },
        },
        middleware: { toolResultTruncate: userMiddleware },
      });

      const middlewares = getMiddlewaresFor("toolResultTruncate");
      const content = "a".repeat(10_000);
      const maxChars = 5_000;
      const result = await runPipeline<
        ToolResultTruncateArgs,
        ToolResultTruncateResult
      >(
        "toolResultTruncate",
        middlewares,
        async (args) => defaultToolResultTruncateTerminal(args),
        { content, maxChars },
        makeCtx(),
        DEFAULT_TIMEOUTS.toolResultTruncate,
      );

      expect(userMiddlewareRan).toBe(true);
      // Terminal still runs after the user passthrough, so output matches
      // the direct helper.
      expect(result.content).toBe(truncateToolResultText(content, maxChars));
      expect(result.truncated).toBe(true);
    });
  });
});
