/**
 * Canonical `conversations.source` string for background memory v2
 * consolidation runs. Lives in a tiny constants module so the route layer can
 * recognize consolidation conversations without importing the consolidation
 * job (which pulls in agent-wake + bootstrap dependencies).
 */
export const MEMORY_V2_CONSOLIDATION_SOURCE = "memory_v2_consolidation";
