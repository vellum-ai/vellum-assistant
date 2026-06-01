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

import type { TrustContext } from "../daemon/trust-context.js";
import {
  defaultEmptyResponsePlugin,
  defaultEmptyResponseTerminal,
} from "../plugins/defaults/empty-response/register.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  EmptyResponseArgs,
  EmptyResponseDecision,
  Middleware,
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
    // Default to `null` (no stop reason reported) so existing fixtures
    // exercise the "organic empty turn" path. The refusal branch
    // dedicated tests below set this to `"refusal"` explicitly.
    stopReason: null,
    ...overrides,
  };
}

/**
 * Refusal-specific nudge text — keep in sync with `register.ts`. Clients
 * (and the model) may match on this exact text.
 */
const CANONICAL_REFUSAL_NUDGE_TEXT =
  '<system_notice>Your previous response was empty because the upstream provider returned stop_reason="refusal". Please answer the user\'s last message directly with a plain-text response. Do not use any tools — just respond with text.</system_notice>';

async function runEmpty(
  args: EmptyResponseArgs,
): Promise<EmptyResponseDecision> {
  return runPipeline(
    "emptyResponse",
    getMiddlewaresFor("emptyResponse"),
    async (a) => defaultEmptyResponseTerminal(a),
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
    // organic-empty-turn nudge guards against. Default accepts (unless the
    // stop reason is `"refusal"` — see the refusal-specific tests below).
    const decision = await runEmpty(
      makeArgs({
        responseContent: [],
        toolUseTurns: 0,
      }),
    );
    expect(decision.action).toBe("accept");
  });

  // ─── Refusal stop ────────────────────────────────────────────────────────

  test("stopReason='refusal' on turn 0 with no content → nudge with refusal text", async () => {
    // The canonical failure mode this branch exists to catch: Anthropic's
    // safety classifier zeros the response on the very first model call,
    // returning a single thinking block and `stopReason: "refusal"`. Without
    // this branch, the terminal would `accept` and the loop would persist
    // an empty assistant bubble to the user.
    const decision = await runEmpty(
      makeArgs({
        stopReason: "refusal",
        responseContent: [],
        toolUseBlocksLength: 0,
        toolUseTurns: 0,
        emptyResponseRetries: 0,
        priorAssistantHadVisibleText: false,
      }),
    );
    expect(decision.action).toBe("nudge");
    expect(decision.nudgeText).toBe(CANONICAL_REFUSAL_NUDGE_TEXT);
  });

  test("stopReason='refusal' with a thinking-only block still nudges", async () => {
    // Thinking blocks aren't visible text — the user sees nothing. A
    // refusal with only thinking content matches the same shape the
    // production log captured (`contentBlocks: 1, toolUseCount: 0`).
    const decision = await runEmpty(
      makeArgs({
        stopReason: "refusal",
        responseContent: [
          {
            type: "thinking",
            thinking: "...",
            signature: "sig",
          } as ContentBlock,
        ],
        toolUseBlocksLength: 0,
        toolUseTurns: 0,
      }),
    );
    expect(decision.action).toBe("nudge");
    expect(decision.nudgeText).toBe(CANONICAL_REFUSAL_NUDGE_TEXT);
  });

  test("stopReason='refusal' but visible text present → accept (model recovered)", async () => {
    // The classifier can flag a partial response; if the model already
    // delivered some visible text before refusing, the user has something
    // to see. Accept.
    const decision = await runEmpty(
      makeArgs({
        stopReason: "refusal",
        responseContent: [{ type: "text", text: "partial answer" }],
      }),
    );
    expect(decision.action).toBe("accept");
  });

  test("stopReason='refusal' but tool_use blocks present → accept", async () => {
    // A refusal with tool_use blocks is unusual (the model wouldn't normally
    // issue tools after a classifier hit) but we still shouldn't nudge —
    // the loop will execute the tools and the model will get another shot.
    const decision = await runEmpty(
      makeArgs({
        stopReason: "refusal",
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

  test("stopReason='refusal' but retries exhausted → accept (no infinite loop)", async () => {
    // Persistent classifier hit shouldn't burn turns indefinitely. Once
    // we've used our retry budget, accept (the user will see an empty
    // bubble, but the loop terminates).
    const decision = await runEmpty(
      makeArgs({
        stopReason: "refusal",
        responseContent: [],
        toolUseTurns: 0,
        emptyResponseRetries: 1,
        maxEmptyResponseRetries: 1,
      }),
    );
    expect(decision.action).toBe("accept");
  });

  test("stopReason='refusal' beats post-tool-empty nudge text (refusal-specific wording)", async () => {
    // When both branches would fire, refusal wins because the refusal
    // text is more accurate ("safety classifier zeroed the response"
    // vs. "summary of what you found or did"). This guards against a
    // future refactor that orders the branches differently.
    const decision = await runEmpty(
      makeArgs({
        stopReason: "refusal",
        responseContent: [],
        toolUseBlocksLength: 0,
        toolUseTurns: 2, // would trip the post-tool branch too
        priorAssistantHadVisibleText: false,
      }),
    );
    expect(decision.action).toBe("nudge");
    expect(decision.nudgeText).toBe(CANONICAL_REFUSAL_NUDGE_TEXT);
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

  test("user plugin registered AFTER the default still runs (no shadowing)", async () => {
    // Production registration order: defaults load first via the side-effect
    // imports in `defaults/index.ts`, then user plugins register on top via
    // `bootstrapPlugins()`. The user's middleware ends up at a deeper onion
    // layer than the default. If the default's middleware were to bypass
    // `next` and decide directly, the user middleware would never run — this
    // test guards against that regression.
    registerPlugin(defaultEmptyResponsePlugin);

    let userMiddlewareRan = false;
    const userMiddleware: Middleware<
      EmptyResponseArgs,
      EmptyResponseDecision
    > = async (args, next) => {
      userMiddlewareRan = true;
      return next(args);
    };
    registerPlugin({
      manifest: {
        name: "late-user-empty-response",
        version: "0.0.1",
      },
      middleware: { emptyResponse: userMiddleware },
    });

    await runEmpty(
      makeArgs({
        responseContent: [],
        toolUseTurns: 2,
        priorAssistantHadVisibleText: false,
      }),
    );

    expect(userMiddlewareRan).toBe(true);
  });
});
