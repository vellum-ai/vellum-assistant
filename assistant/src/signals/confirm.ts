/**
 * Handle confirmation decisions delivered via signal files from the CLI.
 *
 * The built-in CLI writes JSON to `signals/confirm` instead of making an
 * HTTP POST to `/v1/confirm`. The daemon's ConfigWatcher detects the file
 * change and invokes {@link handleConfirmationSignal}, which reads the
 * payload and resolves the pending interaction in-process.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import type { UserDecision } from "../permissions/types.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:confirm");

const VALID_DECISIONS: ReadonlySet<string> = new Set<string>([
  "allow",
  "allow_10m",
  "allow_conversation",
  "always_allow",
  "always_allow_high_risk",
  "deny",
  "always_deny",
  "temporary_override",
]);

function isUserDecision(value: string): value is UserDecision {
  return VALID_DECISIONS.has(value);
}

/**
 * Read the `signals/confirm` file and resolve the pending interaction.
 * Called by ConfigWatcher when the signal file is written or modified.
 */
export function handleConfirmationSignal(): void {
  if (getIsContainerized()) return;

  try {
    const content = readFileSync(join(getSignalsDir(), "confirm"), "utf-8");
    const parsed = JSON.parse(content) as {
      requestId?: string;
      decision?: string;
    };
    const { requestId, decision } = parsed;

    if (!requestId || typeof requestId !== "string") {
      log.warn("Confirmation signal missing requestId");
      return;
    }
    if (!decision || !isUserDecision(decision)) {
      log.warn({ decision }, "Confirmation signal has invalid decision");
      return;
    }

    const interaction = pendingInteractions.resolve(requestId);
    if (!interaction) {
      log.warn({ requestId }, "No pending interaction for confirmation signal");
      return;
    }

    if (interaction.directResolve) {
      interaction.directResolve(decision);
    } else {
      interaction.conversation!.handleConfirmationResponse(
        requestId,
        decision,
        undefined,
        undefined,
        undefined,
        { source: "button" },
      );
    }
    log.info({ requestId, decision }, "Confirmation resolved via signal file");
  } catch (err) {
    log.error({ err }, "Failed to handle confirmation signal");
  }
}
