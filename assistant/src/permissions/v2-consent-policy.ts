import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { getConversationHostAccess as loadConversationHostAccess } from "../memory/conversation-crud.js";
import { isSideEffectTool } from "../tools/side-effects.js";
import type { ToolContext } from "../tools/types.js";
import type { AllowlistOption, ScopeOption, UserDecision } from "./types.js";
import { isHostTool } from "./workspace-policy.js";

export type V2ConsentDisposition =
  | "legacy"
  | "auto_allow"
  | "prompt_host_access";

type PromptLike = {
  toolName: string;
  allowlistOptions?: readonly AllowlistOption[];
  scopeOptions?: readonly ScopeOption[];
  persistentDecisionsAllowed?: boolean;
  temporaryOptionsAvailable?: readonly ("allow_10m" | "allow_conversation")[];
};

export const CONVERSATION_HOST_ACCESS_PROMPT = Object.freeze({
  allowlistOptions: [] as AllowlistOption[],
  scopeOptions: [] as ScopeOption[],
  persistentDecisionsAllowed: false as const,
  temporaryOptionsAvailable: undefined as
    | Array<"allow_10m" | "allow_conversation">
    | undefined,
});

export function isPermissionControlsV2Enabled(): boolean {
  return isAssistantFeatureFlagEnabled("permission-controls-v2", getConfig());
}

export function isConversationHostAccessEnabled(
  conversationId: string,
): boolean {
  return loadConversationHostAccess(conversationId);
}

export function evaluateV2ConsentDisposition(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): V2ConsentDisposition {
  if (!isPermissionControlsV2Enabled()) {
    return "legacy";
  }

  if (context.requireFreshApproval) {
    return "legacy";
  }

  if (context.forcePromptSideEffects && isSideEffectTool(toolName, input)) {
    return "legacy";
  }

  if (!isHostTool(toolName)) {
    return "auto_allow";
  }

  return loadConversationHostAccess(context.conversationId)
    ? "auto_allow"
    : "prompt_host_access";
}

export function isConversationHostAccessEnablePrompt(
  details: PromptLike | undefined,
): boolean {
  if (!details) {
    return false;
  }

  return (
    isHostTool(details.toolName) &&
    (details.allowlistOptions?.length ?? 0) === 0 &&
    (details.scopeOptions?.length ?? 0) === 0 &&
    details.persistentDecisionsAllowed === false &&
    (details.temporaryOptionsAvailable?.length ?? 0) === 0
  );
}

export function isConversationHostAccessDecision(
  decision: UserDecision,
): decision is "allow" | "deny" {
  return decision === "allow" || decision === "deny";
}
