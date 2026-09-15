import { getConfig } from "../../../config/loader.js";
import { getConversation } from "../../../persistence/conversation-crud.js";
import type { ToolContext } from "../../../tools/types.js";
import { MEMORY_RETROSPECTIVE_ORIGIN } from "./memory-retrospective-constants.js";

export interface RetrospectiveSkillMonitoringContext {
  conversationId: string;
  runConversationId: string;
}

/** Resolve the monitored retrospective lineage shared by skill tools. */
export function resolveRetrospectiveSkillMonitoringContext(
  context: ToolContext,
  deps: {
    monitoringEnabled?: () => boolean;
    getConversation?: (
      id: string,
    ) => { forkParentConversationId: string | null } | null;
  } = {},
): RetrospectiveSkillMonitoringContext | null {
  if (
    context.requestOrigin !== MEMORY_RETROSPECTIVE_ORIGIN ||
    !context.conversationId
  ) {
    return null;
  }
  const monitoringEnabled =
    deps.monitoringEnabled ??
    (() => getConfig().memory.retrospective.skillImprovementMonitoring);
  if (!monitoringEnabled()) {
    return null;
  }
  const lookupConversation = deps.getConversation ?? getConversation;
  const conversationId = lookupConversation(
    context.conversationId,
  )?.forkParentConversationId;
  if (!conversationId) {
    return null;
  }
  return {
    conversationId,
    runConversationId: context.conversationId,
  };
}
