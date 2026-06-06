import { emitActivationMoment } from "../../../../telemetry/activation-emit.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

/**
 * Record an activation-funnel milestone for the current conversation.
 *
 * This executor is a thin wrapper around `emitActivationMoment`, which owns all
 * gating (unknown step, daemon-owned msg_5, non-rail session) and is itself
 * best-effort: it never throws. To preserve that guarantee at the tool boundary
 * we likewise never error the turn — an expected rejection (unknown step, wrong
 * session, daemon-owned step) returns a terse, non-error result so the model can
 * keep going. The only signal the model needs is "recorded" vs "skipped".
 */
export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const stepName = typeof input.step_name === "string" ? input.step_name : "";

  const result = emitActivationMoment({
    stepName,
    conversationId: context.conversationId,
  });

  if (result.ok) {
    return {
      content: `Recorded activation milestone: ${stepName}`,
      isError: false,
    };
  }

  // Expected, benign rejection — never error the turn.
  return {
    content: `Activation milestone not recorded (${result.reason ?? "skipped"}).`,
    isError: false,
  };
}
