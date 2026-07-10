/**
 * `run_workflow` core implementation — a thin launcher over
 * {@link WorkflowRunManager}.
 *
 * The assistant calls this to kick off an autonomous, multi-agent workflow from
 * either an inline script or a saved workflow name. All orchestration logic
 * lives in the run manager and engine; this implementation only validates
 * input, builds the per-run capability manifest, resolves the originating
 * conversation's trust context, and fires `start()` (which returns immediately —
 * the run is asynchronous; its completion is surfaced later as a conversation
 * injection).
 *
 * The script-authoring contract the assistant follows when writing workflow
 * scripts lives in the `workflows` bundled skill's SKILL.md, the single source
 * of truth the model reads when generating the `script`.
 */

import { findConversation } from "../../daemon/conversation-registry.js";
import { FALLBACK_TURN_TRUST } from "../../daemon/trust-context.js";
import type { TrustContext } from "../../daemon/trust-context-types.js";
import { CapabilityManifestSchema } from "../../workflows/capabilities.js";
import { getWorkflowRunManager } from "../../workflows/run-manager.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Resolve the {@link TrustContext} to forward to the run's leaves. Prefer the
 * originating conversation's per-turn snapshot (the same context the live turn
 * is running under), then its resolved trust context, and finally a synthetic
 * fallback built from the tool context's `trustClass`. We never elevate beyond
 * the tool context's own trust class.
 */
function resolveTrustContext(context: ToolContext): TrustContext {
  const conversation = findConversation(context.conversationId);
  const fromConversation =
    conversation?.currentTurnTrustContext ?? conversation?.trustContext;
  if (fromConversation) return fromConversation;
  return { ...FALLBACK_TURN_TRUST, trustClass: context.trustClass };
}

export async function executeRunWorkflow(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const script = input.script as string | undefined;
  const name = input.name as string | undefined;

  // Exactly one of script/name is required.
  if ((script == null) === (name == null)) {
    return {
      content:
        'Provide exactly one of "script" (inline workflow source) or "name" (saved workflow name).',
      isError: true,
    };
  }

  const args = (input.args as Record<string, unknown> | undefined) ?? {};
  const label = input.label as string | undefined;
  const trustContext = resolveTrustContext(context);

  try {
    // The schema fills defaults (empty arrays, persona:false) for omitted
    // fields and throws (caught below) on a malformed `capabilities` object.
    const manifest = CapabilityManifestSchema.parse(input.capabilities ?? {});
    const { runId } = getWorkflowRunManager().start({
      ...(script != null ? { scriptSource: script } : { name: name as string }),
      args,
      manifest,
      conversationId: context.conversationId,
      ...(context.toolUseId ? { toolUseId: context.toolUseId } : {}),
      ...(label ? { label } : {}),
      trustContext,
    });

    return {
      content: JSON.stringify({
        runId,
        status: "running",
        message:
          "Workflow started. You will be notified in this conversation when it completes — do NOT poll. Use manage_workflows to check status or abort if needed.",
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to start workflow: ${msg}`, isError: true };
  }
}
