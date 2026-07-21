/**
 * The memory feature's model-visible tools: `remember` and `recall`.
 *
 * Core, always-loaded tools registered via the host tool manifest
 * (`tools/tool-manifest.ts`), so they carry core/workspace-override precedence
 * and the `"memory"` tool category. Their implementations source from the
 * memory feature (`src/memory/*`).
 */

import { getConfig, getConfigReadOnly } from "../../../config/loader.js";
import { usesConceptPageMemory } from "../../../config/memory-v3-gate.js";
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
import { getWorkspaceDir } from "./paths.js";
import { deletePage } from "./v2/page-store.js";

// ── remember ────────────────────────────────────────────────────────

export const rememberTool = {
  name: "remember",
  description: graphRememberDefinition.description,
  category: "memory",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  // The [[slug]] page-hint guidance applies only under the concept-page
  // memory model (v1/PKB has no pages for hints to reference). The thunk is
  // re-resolved on every read of the content description — the registry's
  // finalized tool shares this schema object by reference — so a runtime
  // config edit reaches the model on the next request, in lockstep with
  // handleRemember re-reading config per call. Read-only accessor: a
  // definition read must never create workspace directories.
  input_schema: buildRememberInputSchema({
    pageHints: () => usesConceptPageMemory(getConfigReadOnly().memory),
  }),

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

// ── delete_memory_page ──────────────────────────────────────────────

/**
 * Remove a single concept page from the memory wiki, addressed by slug.
 *
 * The one page-maintenance primitive consolidation needs that the read/write
 * file tools cannot cover: retiring a merged/renamed/dead-stub page. Scoped to
 * `memory/concepts/**` by construction — {@link deletePage} runs the slug
 * through `validateSlug` and resolves it under the concepts root, so a
 * traversal-shaped slug throws rather than escaping the tree. Deleting is the
 * whole capability: no shell, no network, no arbitrary-path reach. Index
 * invalidation is handled by `deletePage`; the stale Qdrant point is reconciled
 * by the `memory_v2_reembed` follow-up the consolidation job already enqueues
 * (its handler drops the embedding when the page is gone from disk).
 *
 * Hidden from the default tool surface (see `ALLOWLIST_ONLY_TOOL_NAMES` in
 * `conversation-tool-setup.ts`): it reaches the wire only for a background run
 * that explicitly allowlists it, so no interactive or untrusted-content turn is
 * ever handed a delete primitive. The guardian capability check below is the
 * second layer — the tool refuses outside a guardian-trust turn regardless of
 * how it was surfaced.
 */
export const deleteMemoryPageTool = {
  name: "delete_memory_page",
  description:
    "Delete one concept page from your memory wiki, addressed by slug (its path under `memory/concepts/` minus `.md` — e.g. `alice`, `people/alice`, `procs/git-flow`). Use during a consolidation/maintenance pass to retire a page you merged into another, renamed (write the new page, then delete the old slug), or dropped as a dead stub. Only concept pages can be deleted — the index files (`recent.md`, `essentials.md`, `threads.md`, `buffer.md`) are rewritten with file_write/file_edit, never deleted. Idempotent: deleting a slug that is already gone is not an error. The immutable archive retains buffer history, so removing a page never loses source facts.",
  category: "memory",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "Slug of the concept page to delete — its path under `memory/concepts/` without the `.md` extension (e.g. `people/alice`).",
      },
      activity: {
        type: "string",
        description:
          "Brief non-technical explanation of what you are doing and why, shown as a status update.",
      },
    },
    required: ["slug", "activity"],
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    if (!resolveCapabilities(context.trustClass).canAccessMemory) {
      return {
        content:
          "delete_memory_page is only available to the guardian because it edits sensitive local memory.",
        isError: true,
      };
    }

    const slug = typeof input.slug === "string" ? input.slug.trim() : "";
    if (!slug) {
      return {
        content: "Error: slug is required and must be a non-empty string.",
        isError: true,
      };
    }

    try {
      await deletePage(getWorkspaceDir(), slug);
      return { content: `Deleted memory page "${slug}".`, isError: false };
    } catch (err) {
      return {
        content: `Error deleting memory page "${slug}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        isError: true,
      };
    }
  },
} satisfies ToolDefinition;
