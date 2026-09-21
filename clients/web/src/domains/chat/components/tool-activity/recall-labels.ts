/**
 * What the drawer calls the places `recall` searches and how hard it searched,
 * for the parts of a recall view that name them.
 */

import type { RecallDepth, RecallSource } from "@vellumai/assistant-api";

import { useTranslation } from "@/i18n";

/** Names a searched place: "Memory", "Conversations", "Workspace files". */
export function useRecallSourceLabel(): (source: RecallSource) => string {
  const { t } = useTranslation("chat");
  return (source) => t("recallLabels.source", { source });
}

/** Names a search depth: "Quick search", "Standard search", "Deep search". */
export function useRecallDepthLabel(): (depth: RecallDepth) => string {
  const { t } = useTranslation("chat");
  return (depth) => t("recallLabels.depth", { depth });
}
