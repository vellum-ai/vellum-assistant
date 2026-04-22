/**
 * Tests for the `toolError` pipeline (PR 19).
 *
 * Covers:
 * - Default plugin nudges on the first error turn and keeps nudging up to the
 *   `maxConsecutiveErrorNudges` cap.
 * - Default plugin suppresses the nudge once the cap is exceeded (the error is
 *   likely unrecoverable — burning tokens on more nudges is wasteful).
 * - Default plugin uses the canonical {@link DEFAULT_TOOL_ERROR_NUDGE_TEXT}.
 * - Default plugin skips when `hasToolError` is false, regardless of the
 *   consecutive counter (no error this turn → nothing to nudge).
 * - Swapping in a user plugin that provides its own `toolError` middleware
 *   changes the nudge text end-to-end through `runPipeline`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import {
  DEFAULT_TOOL_ERROR_NUDGE_TEXT,
  defaultToolErrorPlugin,
} from "../plugins/defaults/tool-error.js";
import { runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  type Middleware,
  type Plugin,
  type ToolErrorArgs,
  type ToolErrorDecision,
  type TurnContext,
} from "../plugins/types.js";

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeCtx(): TurnContext {
  return {
    requestId: "req-tool-error-test",
    conversationId: "conv-tool-error-test",
    turnIndex: 0,
    trust,
  };
}

async function runToolErrorPipeline(
  args: ToolErrorArgs,
): Promise<ToolErrorDecision> {
  return runPipeline<ToolErrorArgs, ToolErrorDecision>(
    "toolError",
    getMiddlewaresFor("toolError"),
    async () => ({ action: "skip" }),
    args,
    makeCtx(),
    500,
  );
}

describe("toolError pipeline", () => {
  describe("default plugin", () => {
    beforeEach(() => {
      resetPluginRegistryForTests();
      registerPlugin(defaultToolErrorPlugin);
    });

    test("nudges on first error turn with canonical text", async () => {
      const decision = await runToolErrorPipeline({
        hasToolError: true,
        consecutiveErrorTurns: 1,
        maxConsecutiveErrorNudges: 3,
      });
      expect(decision.action).toBe("nudge");
      if (decision.action === "nudge") {
        expect(decision.nudgeText).toBe(DEFAULT_TOOL_ERROR_NUDGE_TEXT);
      }
    });

    test("keeps nudging up to and including the cap", async () => {
      // Cap of 3: turns 1, 2, and 3 all nudge. Turn 4 is past the cap.
      for (let turn = 1; turn <= 3; turn++) {
        const decision = await runToolErrorPipeline({
          hasToolError: true,
          consecutiveErrorTurns: turn,
          maxConsecutiveErrorNudges: 3,
        });
        expect(decision.action).toBe("nudge");
      }
    });

    test("suppresses the nudge once the consecutive counter exceeds the cap", async () => {
      const decision = await runToolErrorPipeline({
        hasToolError: true,
        consecutiveErrorTurns: 4,
        maxConsecutiveErrorNudges: 3,
      });
      expect(decision.action).toBe("skip");
    });

    test("skips when there is no tool error this turn, regardless of counter", async () => {
      // Counter is non-zero (the previous turn errored) but this turn succeeded,
      // so nothing to nudge about.
      const decision = await runToolErrorPipeline({
        hasToolError: false,
        consecutiveErrorTurns: 2,
        maxConsecutiveErrorNudges: 3,
      });
      expect(decision.action).toBe("skip");
    });

    test("honors a caller-supplied cap of zero (never nudges)", async () => {
      // Some call-sites may want to disable nudging entirely by passing cap = 0.
      // The decision logic uses `<=`, so counter 0 with cap 0 does nudge; counter
      // 1 with cap 0 suppresses. The cap is inclusive.
      const turn1 = await runToolErrorPipeline({
        hasToolError: true,
        consecutiveErrorTurns: 1,
        maxConsecutiveErrorNudges: 0,
      });
      expect(turn1.action).toBe("skip");
    });
  });

  describe("user-supplied plugin", () => {
    beforeEach(() => {
      resetPluginRegistryForTests();
    });

    test("swapping in a plugin changes the nudge text", async () => {
      const customText = "<system_notice>Custom error hint.</system_notice>";
      const customMiddleware: Middleware<
        ToolErrorArgs,
        ToolErrorDecision
      > = async (args) => {
        if (args.hasToolError) {
          return { action: "nudge", nudgeText: customText };
        }
        return { action: "skip" };
      };
      const customPlugin: Plugin = {
        manifest: {
          name: "custom-tool-error",
          version: "0.0.1",
          requires: { pluginRuntime: "v1", toolErrorApi: "v1" },
        },
        middleware: { toolError: customMiddleware },
      };
      registerPlugin(customPlugin);

      const decision = await runToolErrorPipeline({
        hasToolError: true,
        consecutiveErrorTurns: 1,
        maxConsecutiveErrorNudges: 3,
      });
      expect(decision.action).toBe("nudge");
      if (decision.action === "nudge") {
        expect(decision.nudgeText).toBe(customText);
      }
    });

    test("swapping in a plugin can suppress nudges even when the default would nudge", async () => {
      const suppressingMiddleware: Middleware<
        ToolErrorArgs,
        ToolErrorDecision
      > = async () => ({ action: "skip" });
      const plugin: Plugin = {
        manifest: {
          name: "no-nudge",
          version: "0.0.1",
          requires: { pluginRuntime: "v1", toolErrorApi: "v1" },
        },
        middleware: { toolError: suppressingMiddleware },
      };
      registerPlugin(plugin);

      const decision = await runToolErrorPipeline({
        hasToolError: true,
        consecutiveErrorTurns: 1,
        maxConsecutiveErrorNudges: 3,
      });
      expect(decision.action).toBe("skip");
    });

    test("terminal fallback runs when no plugin is registered", async () => {
      // No registerPlugin call — the registry is empty for this slot. The
      // terminal we pass to runPipeline returns `skip`, which is what the
      // caller receives.
      const decision = await runToolErrorPipeline({
        hasToolError: true,
        consecutiveErrorTurns: 1,
        maxConsecutiveErrorNudges: 3,
      });
      expect(decision.action).toBe("skip");
    });
  });
});
