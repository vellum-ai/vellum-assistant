import {
  extractInputSummary,
  friendlyToolLabel,
} from "@/domains/chat/components/tool-call-chip/utils";
import {
  ACTIVITY_KEYS,
  readToolInputString,
} from "@/domains/chat/utils/tool-input";

/**
 * How a pending tool approval is put to the user, wherever it is drawn.
 *
 * `context` is what the assistant was doing when it hit the gate: the live
 * activity label when the tool call carries one, then a custom confirmation
 * title, then the friendly tool label. `ask` is the human-readable request;
 * older daemons send only the risk reason, which reads well enough in the same
 * slot. Null when there is neither.
 */
export function confirmationAsk(
  toolName: string,
  input: Record<string, unknown> | undefined,
  confirmation: { title?: string; description?: string; riskReason?: string },
): { context: string; ask: string | null } {
  const activity = readToolInputString(input ?? {}, ...ACTIVITY_KEYS);
  return {
    context:
      activity ||
      confirmation.title ||
      friendlyToolLabel(toolName, extractInputSummary(toolName, input ?? {})),
    ask: confirmation.description || confirmation.riskReason || null,
  };
}
