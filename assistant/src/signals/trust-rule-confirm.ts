/**
 * Handle combined trust-rule + confirmation signals from the CLI.
 *
 * When the user chooses to allowlist/denylist a tool pattern from a
 * confirmation prompt, the CLI writes JSON to `signals/trust-rule-confirm`.
 * The daemon's ConfigWatcher detects the file change and invokes
 * {@link handleTrustRuleConfirmSignal}, which adds the trust rule and
 * resolves the pending confirmation in one step.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { addRule } from "../permissions/trust-store.js";
import type { UserDecision } from "../permissions/types.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { getTool } from "../tools/registry.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("signal:trust-rule-confirm");

const VALID_TRUST_DECISIONS: ReadonlySet<string> = new Set(["allow", "deny"]);

const VALID_CONFIRM_DECISIONS: ReadonlySet<string> = new Set(["allow", "deny"]);

function isUserDecision(value: string): value is UserDecision {
  return VALID_CONFIRM_DECISIONS.has(value);
}

/**
 * Read the `signals/trust-rule-confirm` file, add the trust rule, and
 * resolve the pending confirmation.
 */
export function handleTrustRuleConfirmSignal(): void {
  try {
    const content = readFileSync(
      join(getWorkspaceDir(), "signals", "trust-rule-confirm"),
      "utf-8",
    );
    const parsed = JSON.parse(content) as {
      requestId?: string;
      pattern?: string;
      scope?: string;
      decision?: string;
      confirmDecision?: string;
      allowHighRisk?: boolean;
    };
    const {
      requestId,
      pattern,
      scope,
      decision,
      confirmDecision,
      allowHighRisk,
    } = parsed;

    if (!requestId || typeof requestId !== "string") {
      log.warn("Trust-rule-confirm signal missing requestId");
      return;
    }
    if (!pattern || typeof pattern !== "string") {
      log.warn({ requestId }, "Trust-rule-confirm signal missing pattern");
      return;
    }
    if (!scope || typeof scope !== "string") {
      log.warn({ requestId }, "Trust-rule-confirm signal missing scope");
      return;
    }
    if (!decision || !VALID_TRUST_DECISIONS.has(decision)) {
      log.warn(
        { requestId, decision },
        "Trust-rule-confirm signal has invalid trust decision",
      );
      return;
    }
    if (!confirmDecision || !isUserDecision(confirmDecision)) {
      log.warn(
        { requestId, confirmDecision },
        "Trust-rule-confirm signal has invalid confirm decision",
      );
      return;
    }

    // Look up the pending interaction (non-destructive) for trust rule validation.
    const interaction = pendingInteractions.get(requestId);
    if (!interaction) {
      log.warn(
        { requestId },
        "No pending interaction for trust-rule-confirm signal",
      );
      return;
    }

    if (!interaction.confirmationDetails) {
      log.warn(
        { requestId },
        "No confirmation details for trust-rule-confirm signal",
      );
      return;
    }

    const confirmation = interaction.confirmationDetails;

    if (confirmation.persistentDecisionsAllowed === false) {
      log.warn(
        { requestId },
        "Persistent trust rules not allowed for this tool invocation",
      );
      return;
    }

    // Validate pattern against server-provided allowlist options.
    const validPatterns = (confirmation.allowlistOptions ?? []).map(
      (o) => o.pattern,
    );
    if (!validPatterns.includes(pattern)) {
      log.warn(
        { requestId, pattern },
        "Pattern does not match any server-provided allowlist option",
      );
      return;
    }

    // Validate scope against server-provided scope options.
    const validScopes = (confirmation.scopeOptions ?? []).map((o) => o.scope);
    if (validScopes.length === 0) {
      if (scope !== "everywhere") {
        log.warn(
          { requestId, scope },
          "Non-scoped tools only accept scope 'everywhere'",
        );
        return;
      }
    } else if (!validScopes.includes(scope)) {
      log.warn(
        { requestId, scope },
        "Scope does not match any server-provided scope option",
      );
      return;
    }

    // Add the trust rule.
    const tool = getTool(confirmation.toolName);
    const executionTarget =
      tool?.origin === "skill" ? confirmation.executionTarget : undefined;
    addRule(
      confirmation.toolName,
      pattern,
      scope,
      decision as "allow" | "deny",
      undefined,
      {
        allowHighRisk: allowHighRisk || undefined,
        executionTarget,
      },
    );
    log.info(
      { tool: confirmation.toolName, pattern, scope, decision, requestId },
      "Trust rule added via signal file",
    );

    // Resolve the confirmation.
    const resolved = pendingInteractions.resolve(requestId);
    if (!resolved) {
      log.warn(
        { requestId },
        "Pending interaction disappeared before confirmation could be resolved",
      );
      return;
    }

    resolved.session.handleConfirmationResponse(
      requestId,
      confirmDecision,
      undefined,
      undefined,
      undefined,
      { source: "button" },
    );
    log.info(
      { requestId, confirmDecision },
      "Confirmation resolved via trust-rule-confirm signal",
    );
  } catch (err) {
    log.error({ err }, "Failed to handle trust-rule-confirm signal");
  }
}
