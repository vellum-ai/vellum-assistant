/**
 * Side-effect hook that bridges the viewer-store's `ruleEditorRequestSeq`
 * counter to the rule-editor open action.
 *
 * The mobile tool-detail overlay (`MobileChatOverlays`) lives in a
 * separate portal subtree and can't reach the rule-editor state directly,
 * so it signals through the viewer store by bumping the seq counter.
 * This hook watches for seq advances and opens the rule editor for the
 * currently active tool detail.
 */

import { useCallback, useEffect, useRef } from "react";

import { useViewerStore } from "@/stores/viewer-store";
import { toolCallToRuleContext } from "@/domains/chat/utils/chat";
import type { DisplayMessage } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRuleEditorBridge(
  messages: DisplayMessage[],
  handleOpenRuleEditorForToolCall: (ctx: ReturnType<typeof toolCallToRuleContext>) => void,
): void {
  const handleToolDetailRiskBadgeClick = useCallback(() => {
    const detail = useViewerStore.getState().activeToolDetail;
    if (!detail) return;
    const tc = messages
      .flatMap((m) => m.toolCalls ?? [])
      .find((t) => t.id === detail.toolCallId);
    if (!tc) return;
    handleOpenRuleEditorForToolCall(toolCallToRuleContext(tc));
  }, [messages, handleOpenRuleEditorForToolCall]);

  const ruleEditorRequestSeq = useViewerStore.use.ruleEditorRequestSeq();
  const handledRuleEditorSeqRef = useRef(ruleEditorRequestSeq);
  useEffect(() => {
    if (ruleEditorRequestSeq === handledRuleEditorSeqRef.current) {
      return;
    }
    handledRuleEditorSeqRef.current = ruleEditorRequestSeq;
    handleToolDetailRiskBadgeClick();
  }, [ruleEditorRequestSeq, handleToolDetailRiskBadgeClick]);
}
