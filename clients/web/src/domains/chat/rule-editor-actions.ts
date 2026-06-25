/**
 * Trust-rule editor interaction handlers.
 *
 * Stateless imperative functions — no React hooks, no component state.
 * Coordinates opening the rule editor, fetching LLM suggestions,
 * and persisting rules via the trust-rules API.
 */

import { captureError } from "@/lib/sentry/capture-error";

import { addTrustRule, fetchTrustRules, suggestTrustRule, updateTrustRule } from "@/lib/trust-rules-api";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { patchTranscriptMessages } from "@/domains/chat/transcript/patch-transcript-messages";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useRuleEditorStore } from "@/domains/chat/rule-editor-store";
import type { RuleEditorContext } from "@/domains/chat/rule-editor-store";
import { clearConfirmationByRequestId } from "@/domains/chat/utils/send-message-utils";
import { deriveCommandText } from "@/domains/chat/utils/chat";
import { toRiskLevel } from "@/domains/chat/utils/risk";
import { submitConfirmation } from "@/domains/chat/api/interactions";
import type { AllowlistOption, DirectoryScopeOption, ScopeOption } from "@/types/interaction-ui-types";
import type { TrustRuleItem, TrustRuleRisk } from "@/types/trust-rules";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload shape shared by both save-rule callbacks. */
export interface TrustRulePayload {
  toolName: string;
  pattern: string;
  riskLevel: TrustRuleRisk;
  scope: string;
}

/** Shape for `handleOpenRuleEditorForToolCall`'s argument. */
export interface ToolCallRuleContext {
  toolName: string;
  riskLevel?: string;
  riskReason?: string;
  input?: Record<string, unknown>;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  directoryScopeOptions: DirectoryScopeOption[];
  matchedTrustRuleId?: string;
}

// ---------------------------------------------------------------------------
// Helpers (command-text building for LLM suggestion endpoint)
// ---------------------------------------------------------------------------

/**
 * Credential-bearing input keys whose values are redacted before the command
 * text is sent to the suggestion LLM. Mirrors the macOS `sensitiveKeys` set
 * (ChatMessage.swift) so neither client leaks secrets into the prompt.
 */
const SENSITIVE_INPUT_KEYS = new Set([
  "value", "secret", "password", "token", "client_secret", "api_key",
  "authorization", "access_token", "refresh_token", "api_secret",
  "accesstoken", "refreshtoken", "apikey", "apisecret", "clientsecret",
  "x-api-key",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_INPUT_KEYS.has(key.toLowerCase());
}

/**
 * Stringifies a tool-input value for the suggestion prompt. Strings pass
 * through; objects/arrays are JSON-encoded with sensitive keys redacted.
 */
function stringifyInputValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, (key, val) =>
      key && isSensitiveKey(key) ? "[redacted]" : val,
    );
  } catch {
    return String(value);
  }
}

/**
 * Builds a full command text from tool call input for the suggestion endpoint.
 * Formats all key-value pairs, giving the LLM full context for pattern suggestion.
 */
function buildFullCommandText(input?: Record<string, unknown>): string {
  if (!input) {
    return "";
  }
  const entries = Object.entries(input).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (entries.length === 0) {
    return "";
  }
  if (entries.length === 1) {
    const [k, v] = entries[0];
    return isSensitiveKey(k) ? "[redacted]" : stringifyInputValue(v);
  }
  return entries
    .map(([k, v]) => `${k}: ${isSensitiveKey(k) ? "[redacted]" : stringifyInputValue(v)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Rule persistence
// ---------------------------------------------------------------------------

/**
 * Unified save-rule logic. Strategy determines how the rule is persisted:
 * - `update-or-create`: updates an existing rule if one is being edited,
 *   otherwise creates a new one. If a pending confirmation exists (requestId),
 *   resolves it via the confirmation API instead.
 * - `always-create`: always creates a new rule regardless of existing context.
 */
async function executeSaveRule(
  strategy: "update-or-create" | "always-create",
  rule: TrustRulePayload,
): Promise<void> {
  const ctx = useStreamStore.getState().streamContext;
  const { ruleEditorContext: context, isSavingRule: saving } = useRuleEditorStore.getState();
  if (!ctx || !context || saving) return;

  // Confirmation path: resolve via the interaction API rather than direct save.
  if (strategy === "update-or-create" && context.requestId) {
    useRuleEditorStore.getState().setIsSavingRule(true);
    useInteractionStore.getState().submitConfirmationStart();
    try {
      const result = await submitConfirmation(
        ctx.assistantId,
        context.requestId,
        "allow",
        { selectedPattern: rule.pattern, selectedScope: rule.scope },
      );
      if (!result.ok) {
        useRuleEditorStore.getState().dismissRuleEditor();
        useChatSessionStore.getState().setError({ message: result.error });
        return;
      }
    } catch (err) {
      captureError(err, { context: "save_trust_rule" });
      useRuleEditorStore.getState().dismissRuleEditor();
      useChatSessionStore.getState().setError({ message: "Failed to save trust rule. Please try again." });
      return;
    } finally {
      useRuleEditorStore.getState().setIsSavingRule(false);
      useInteractionStore.getState().submitConfirmationEnd();
    }

    useInteractionStore.getState().dismissConfirmationIfMatches(context.requestId);
    useInteractionStore.getState().setInlineConfirmationToolCallId(null);
    useChatSessionStore.getState().deleteConfirmationToolCall(context.requestId);
    patchTranscriptMessages((prev: DisplayMessage[]) =>
      clearConfirmationByRequestId(prev, context.requestId),
    );
    useRuleEditorStore.getState().dismissRuleEditor();
    return;
  }

  // Direct save path: persist rule to the trust-rules API.
  useRuleEditorStore.getState().setIsSavingRule(true);
  try {
    if (strategy === "update-or-create" && context.existingRule) {
      await updateTrustRule(ctx.assistantId, context.existingRule.id, {
        risk: rule.riskLevel,
      });
    } else {
      await addTrustRule(ctx.assistantId, {
        tool: rule.toolName,
        pattern: rule.pattern,
        risk: rule.riskLevel,
        description: `${rule.toolName} — ${rule.pattern}`,
        scope: rule.scope,
      });
    }
  } catch (err) {
    captureError(err, { context: strategy === "always-create" ? "save_as_new_trust_rule" : "save_trust_rule_direct" });
    useChatSessionStore.getState().setError({ message: "Failed to save trust rule. Please try again." });
  } finally {
    useRuleEditorStore.getState().setIsSavingRule(false);
    useRuleEditorStore.getState().dismissRuleEditor();
  }
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

/**
 * Fire a best-effort LLM trust-rule suggestion in the background and merge
 * the result into the open rule-editor context. Aborts any in-flight
 * suggestion first so reopening the editor can't apply a stale one.
 */
export function fireSuggestion(params: {
  assistantId: string;
  toolName: string;
  input?: Record<string, unknown>;
  riskLevel?: string;
  riskReason?: string;
  resolvedAllowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  directoryScopeOptions: DirectoryScopeOption[];
  existingRule?: TrustRuleItem;
}): void {
  const abortController = useRuleEditorStore.getState().newSuggestionController();

  const scopeOpts =
    params.resolvedAllowlistOptions.length > 0
      ? params.resolvedAllowlistOptions.map((o) => ({ pattern: o.pattern, label: o.label }))
      : params.scopeOptions.map((o) => ({ pattern: o.scope, label: o.label }));

  void (async () => {
    try {
      const suggestion = await suggestTrustRule(params.assistantId, {
        tool: params.toolName,
        command: buildFullCommandText(params.input),
        riskAssessment: {
          risk: params.riskLevel ?? "medium",
          reasoning: params.riskReason ?? "",
          reasonDescription: params.riskReason ?? "",
        },
        scopeOptions: scopeOpts,
        directoryScopeOptions: params.directoryScopeOptions.map((o) => ({ scope: o.scope, label: o.label })),
        intent: "auto_approve",
        existingRule: params.existingRule
          ? { id: params.existingRule.id, pattern: params.existingRule.pattern, risk: params.existingRule.risk }
          : undefined,
      });
      if (!abortController.signal.aborted) {
        useRuleEditorStore.getState().updateRuleEditorContext({ suggestion });
      }
    } catch {
      // Suggestion is best-effort — silently ignore failures.
    }
  })();
}

/**
 * Open the rule editor for a specific tool call (from the risk badge or
 * transcript action). Fetches the matched rule if editing, then fires
 * the LLM suggestion in the background.
 */
export function handleOpenRuleEditorForToolCall(context: ToolCallRuleContext): void {
  const ctx = useStreamStore.getState().streamContext;
  if (!ctx) {
    return;
  }

  // Cancel any previous suggestion fetch.
  useRuleEditorStore.getState().abortSuggestion();

  // Only `riskAllowlistOptions` (minimatch globs) are valid save-path
  // patterns. `riskScopeOptions` are regex-flavored, display-only and
  // must NOT be persisted as trust rules.
  const resolvedAllowlistOptions: AllowlistOption[] =
    context.allowlistOptions.length > 0 ? context.allowlistOptions : [];

  const baseContext: RuleEditorContext = {
    requestId: "",
    toolName: context.toolName,
    riskLevel: toRiskLevel(context.riskLevel),
    allowlistOptions: resolvedAllowlistOptions,
    scopeOptions: context.scopeOptions,
    directoryScopeOptions: context.directoryScopeOptions,
    commandText: deriveCommandText(context.input, context.toolName),
    commandDescription: context.riskReason ?? "",
  };

  // Fetch matched rule (edit mode) then open modal immediately.
  const openModal = async () => {
    let existingRule: TrustRuleItem | undefined;
    if (context.matchedTrustRuleId) {
      try {
        const rules = await fetchTrustRules(ctx.assistantId, { tool: context.toolName });
        existingRule = rules.find((r) => r.id === context.matchedTrustRuleId);
        if (!existingRule) {
          const defaultRules = await fetchTrustRules(ctx.assistantId, { origin: "default", tool: context.toolName });
          existingRule = defaultRules.find((r) => r.id === context.matchedTrustRuleId);
        }
      } catch {
        // Failed to fetch matched rule — fall through to create mode.
      }
    }

    const editorContext: RuleEditorContext = { ...baseContext, existingRule };
    useRuleEditorStore.getState().openRuleEditor(editorContext);

    // Fire LLM suggestion in the background.
    fireSuggestion({
      assistantId: ctx.assistantId,
      toolName: context.toolName,
      input: context.input,
      riskLevel: context.riskLevel,
      riskReason: context.riskReason,
      resolvedAllowlistOptions,
      scopeOptions: context.scopeOptions,
      directoryScopeOptions: context.directoryScopeOptions,
      existingRule,
    });
  };

  openModal().catch((err) => captureError(err, { context: "open_rule_editor" }));
}

/** Save (update-or-create) a trust rule from the editor modal. */
export function handleSaveRule(rule: TrustRulePayload): Promise<void> {
  return executeSaveRule("update-or-create", rule);
}

/** Save as a new trust rule (always creates, ignoring existing context). */
export function handleSaveAsNewRule(rule: TrustRulePayload): Promise<void> {
  return executeSaveRule("always-create", rule);
}
