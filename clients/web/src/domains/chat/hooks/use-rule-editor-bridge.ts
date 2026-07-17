/**
 * Side-effect hook that bridges the viewer-store's `ruleEditorRequestSeq`
 * counter to the rule-editor open action.
 *
 * Tool-detail surfaces (the desktop drawer, the mobile overlay portal, the
 * activity-steps drill-in) can't reach the rule-editor state directly, so
 * they signal through the viewer store: `requestRuleEditor(toolCallId)`
 * records the target and bumps the seq counter. This hook watches for seq
 * advances and opens the rule editor for the recorded tool call.
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
  const handleRuleEditorRequest = useCallback(() => {
    const toolCallId = useViewerStore.getState().ruleEditorRequestToolCallId;
    if (!toolCallId) return;
    const tc = messages
      .flatMap((m) => m.toolCalls ?? [])
      .find((t) => t.id === toolCallId);
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
    handleRuleEditorRequest();
  }, [ruleEditorRequestSeq, handleRuleEditorRequest]);
}
