/**
 * The memory feature's model-visible tools: `remember` and `recall`.
 *
 * Core, always-loaded tools registered via the host tool manifest
 * (`tools/tool-manifest.ts`), so they carry core/workspace-override precedence
 * and the `"memory"` tool category. Their implementations source from the
 * memory feature (`src/memory/*`).
 */

import { getConfig } from "../../../config/loader.js";
import { RiskLevel } from "../../../permissions/types.js";
import { resolveCapabilities } from "../../../runtime/capabilities.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../../../tools/types.js";
import { runAgenticRecall } from "./context-search/agent-runner.js";
import type { RecallInput } from "./context-search/types.js";
import { handleRemember, type RememberInput } from "./graph/tool-handlers.js";
import {
  graphRecallDefinition,
  graphRememberDefinition,
} from "./graph/tools.js";

// ── remember ────────────────────────────────────────────────────────

export const rememberTool = {
  name: "remember",
  description: graphRememberDefinition.description,
  category: "memory",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: graphRememberDefinition.input_schema,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const typedInput = input as unknown as RememberInput;
    const result = handleRemember(
      typedInput,
      context.conversationId,
      "default",
      getConfig(),
    );
    return {
      content: result.message,
      isError: !result.success,
      ...(typedInput.finish_turn === true ? { yieldToUser: true } : {}),
    };
  },
} satisfies ToolDefinition;

// ── recall ──────────────────────────────────────────────────────────

export const recallTool = {
  name: "recall",
  description: graphRecallDefinition.description,
  category: "memory",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: graphRecallDefinition.input_schema,

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (!resolveCapabilities(context.trustClass).canAccessMemory) {
      return {
        content:
          "Recall is only available to the guardian because it can read sensitive local context.",
        isError: true,
      };
    }

    const config = getConfig();
    const result = await runAgenticRecall(input as unknown as RecallInput, {
      workingDir: context.workingDir,
      conversationId: context.conversationId,
      config,
      signal: context.signal,
    });

    return { content: result.content, isError: false };
  },
} satisfies ToolDefinition;
