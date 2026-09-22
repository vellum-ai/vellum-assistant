/**
 * Guardian action message composition.
 *
 * Returns the deterministic, voice-friendly copy for a guardian action
 * notice. The only notice left is the one the expiry sweep
 * (`calls/guardian-action-sweep.ts`) sends to each place a guardian request
 * was delivered once the request expires unanswered.
 */
import type { GuardianActionMessageContext } from "./message-composer-types.js";

export type {
  GuardianActionMessageContext,
  GuardianActionMessageScenario,
} from "./message-composer-types.js";

/** Compose the user-facing copy for a guardian action notice. */
export function composeGuardianActionMessage(
  context: GuardianActionMessageContext,
): string {
  switch (context.scenario) {
    case "guardian_stale_expired":
      return "That request has already expired. No further action is needed.";

    default: {
      const _exhaustive: never = context.scenario;
      return `Guardian action update. ${String(_exhaustive)}`;
    }
  }
}
