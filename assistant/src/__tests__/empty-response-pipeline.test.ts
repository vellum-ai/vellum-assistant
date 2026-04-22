/**
 * Tests for the `emptyResponse` plugin pipeline (PR 18).
 *
 * Covers:
 * - Default plugin decision matches the original inline loop logic for the
 *   canonical cases (empty-after-tools → nudge, visible-text → accept,
 *   tool-use-blocks-present → accept, retries-exhausted → accept,
 *   prior-visible-text-in-run → accept).
 * - Swapping in a custom middleware that returns `action: "accept"` prevents
 *   the nudge and lets the loop fall through to history append.
 * - Swapping in a custom middleware that returns `action: "error"` is
 *   propagated by the pipeline so the loop can surface a clear error.
 *
 * The loop's actual side-effects (history append, retry counter bump, log
 * emission) live in `agent/loop.ts` and are covered by integration tests in
 * `conversation-agent-loop.test.ts`. This file isolates the pipeline.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { defaultEmptyResponsePlugin } from "../plugins/defaults/empty-response.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  EmptyResponseArgs,
  EmptyResponseDecision,
  Plugin,
  TurnContext,
} from "../plugins/types.js";
import type { ContentBlock } from "../providers/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeCtx(): TurnContext {
  return {
    requestId: "req-empty-response",
    conversationId: "conv-empty-response",
    turnIndex: 2,
    trust,
  };
}

/**
 * The nudge text has to match the loop's original inline string verbatim —
 * clients (and the model) may match on this exact text.
 */
const CANONICAL_NUDGE_TEXT =
  "<system_notice>Your previous response was empty. You must respond to the user with a summary of what you found or did. Do not use any tools — just respond with text.</system_notice>";

const emptyTextBlock: ContentBlock = { type: "text", text: "   " };

function makeArgs(
  overrides: Partial<EmptyResponseArgs> = {},
): EmptyResponseArgs {
  return {
    responseContent: [],
    toolUseBlocksLength: 0,
    toolUseTurns: 1,
    emptyResponseRetries: 0,
    maxEmptyResponseRetries: 1,
    priorAssistantHadVisibleText: false,
    ...overrides,
  };
}

async function runEmpty(
  args: EmptyResponseArgs,
): Promise<EmptyResponseDecision> {
  return runPipeline(
    "emptyResponse",
    getMiddlewaresFor("emptyResponse"),
    async () => ({ action: "accept" }),
    args,
    makeCtx(),
    DEFAULT_TIMEOUTS.emptyResponse,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("emptyResponse pipeline — default decisions", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(defaultEmptyResponsePlugin);
  });

  test("empty turn after tool results → nudge with canonical text", async () => {
    // Whitespace-only text counts as empty (matches inline `trim().length > 0`).
    const decision = await runEmpty(
      makeArgs({
        responseContent: [emptyTextBlock],
        toolUseBlocksLength: 0,
        toolUseTurns: 2,
        emptyResponseRetries: 0,
        priorAssistantHadVisibleText: false,
      }),
    );
    expect(decision.action).toBe("nudge");
    expect(decision.nudgeText).toBe(CANONICAL_NUDGE_TEXT);
  });

  test("turn contains visible text → accept", async () => {
    const decision = await runEmpty(
      makeArgs({
        responseContent: [{ type: "text", text: "here is a summary" }],
      }),
    );
    expect(decision.action).toBe("accept");
  });

  test("turn contains tool_use blocks → accept (not empty)", async () => {
    const decision = await runEmpty(
      makeArgs({
        responseContent: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "read",
            input: { path: "/tmp/x" },
          } as ContentBlock,
        ],
        toolUseBlocksLength: 1,
      }),
    );
    expect(decision.action).toBe("accept");
  });

  test("retries already exhausted → accept", async () => {
    const decision = await runEmpty(
      makeArgs({
        responseContent: [],
        toolUseTurns: 3,
        emptyResponseRetries: 1,
        maxEmptyResponseRetries: 1,
      }),
    );
    expect(decision.action).toBe("accept");
  });

  test("prior assistant turn already delivered visible text → accept", async () => {
    // Model said its piece earlier, ended with a side-effect tool, returned
    // empty. Nudging would force a verbatim re-send of text the user already
    // saw. Default must accept.
    const decision = await runEmpty(
      makeArgs({
        responseContent: [],
        toolUseTurns: 2,
        priorAssistantHadVisibleText: true,
      }),
    );
    expect(decision.action).toBe("accept");
  });

  test("no prior tool-use turn (toolUseTurns === 0) → accept", async () => {
    // Empty first assistant response with no tools is not the pattern the
    // nudge guards against. Default accepts.
    const decision = await runEmpty(
      makeArgs({
        responseContent: [],
        toolUseTurns: 0,
      }),
    );
    expect(decision.action).toBe("accept");
  });
});

describe("emptyResponse pipeline — custom middleware overrides", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("plugin returning action:accept suppresses the nudge", async () => {
    // Build a plugin whose middleware short-circuits with accept. Register it
    // as the ONLY plugin so its decision is authoritative. The loop-side
    // effect (no nudge appended) is covered by integration tests; here we
    // assert the pipeline returns what the plugin returned.
    const acceptPlugin: Plugin = {
      manifest: {
        name: "force-accept",
        version: "1.0.0",
        requires: { pluginRuntime: "v1" },
      },
      middleware: {
        emptyResponse: async () => ({ action: "accept" }),
      },
    };
    registerPlugin(acceptPlugin);

    const decision = await runEmpty(
      makeArgs({
        // Conditions the default would nudge on — but the custom plugin wins.
        responseContent: [],
        toolUseTurns: 2,
        emptyResponseRetries: 0,
        priorAssistantHadVisibleText: false,
      }),
    );
    expect(decision.action).toBe("accept");
    // `nudgeText` must not leak from the acceptance branch.
    expect(decision.nudgeText).toBeUndefined();
  });

  test("plugin returning action:error is propagated to the caller", async () => {
    const errorPlugin: Plugin = {
      manifest: {
        name: "force-error",
        version: "1.0.0",
        requires: { pluginRuntime: "v1" },
      },
      middleware: {
        emptyResponse: async () => ({ action: "error" }),
      },
    };
    registerPlugin(errorPlugin);

    const decision = await runEmpty(makeArgs());
    expect(decision.action).toBe("error");
  });

  test("plugin overriding default nudge text changes the returned text", async () => {
    // Exercises the wrapping semantics: the custom plugin observes the
    // default's decision via `next(args)` and rewrites only the text. This
    // is the canonical "plugin wraps default" pattern.
    const rewriterPlugin: Plugin = {
      manifest: {
        name: "rewrite-nudge",
        version: "1.0.0",
        requires: { pluginRuntime: "v1" },
      },
      middleware: {
        emptyResponse: async (args, next, ctx) => {
          const downstream = await next(args);
          if (downstream.action !== "nudge") return downstream;
          void ctx; // silence lint
          return { action: "nudge", nudgeText: "ALTERED_NUDGE" };
        },
      },
    };
    // Register the custom plugin FIRST so it is the outermost middleware; the
    // default registers second and acts as the inner decision maker.
    registerPlugin(rewriterPlugin);
    registerPlugin(defaultEmptyResponsePlugin);

    const decision = await runEmpty(
      makeArgs({
        responseContent: [],
        toolUseTurns: 2,
        priorAssistantHadVisibleText: false,
      }),
    );
    expect(decision.action).toBe("nudge");
    expect(decision.nudgeText).toBe("ALTERED_NUDGE");
  });
});
