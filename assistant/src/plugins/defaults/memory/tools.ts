/**
 * The memory feature's model-visible tools: `remember` and `recall`.
 *
 * Core, always-loaded tools registered via the host tool manifest
 * (`tools/tool-manifest.ts`), so they carry core/workspace-override precedence
 * and the `"memory"` tool category. Their implementations source from the
 * memory feature (`src/memory/*`).
 */

import { getConfig, getConfigReadOnly } from "../../../config/loader.js";
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
  buildRememberInputSchema,
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
  // The [[slug]] page-hint guidance applies only under the wiki memory model
  // (v1/PKB has no pages for hints to reference), so the schema is resolved
  // against config when the registry finalizes the tool at startup rather
  // than baked in statically. Read-only accessor: a definition read must
  // never create workspace directories.
  get input_schema() {
    return buildRememberInputSchema({
      pageHints: getConfigReadOnly().memory.v2.enabled,
    });
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const typedInput = input as unknown as RememberInput;
    const result = handleRemember(
      typedInput,
      context.conversationId,
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
