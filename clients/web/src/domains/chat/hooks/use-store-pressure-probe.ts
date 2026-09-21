import { useEffect } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { installStorePressureProbe } from "@/lib/commit-pressure";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Names the chat route's store writes to the commit-pressure probe for as long
 * as the route is mounted, which is the same span `recordCommit` counts
 * commits over.
 *
 * The stores listed are the ones a live conversation writes to while it
 * streams or while the user works in it: the transcript snapshot, turn phase
 * and live activity, the composer draft, pending prompts, the detail panels,
 * the conversation list, the mirrored microphone level, and the subagent and
 * workflow projections. A store the route reads but nothing writes mid-turn
 * (identity, feature flags) adds a listener and no signal.
 */
export function useStorePressureProbe(): void {
  useEffect(() => {
    const uninstall = [
      installStorePressureProbe("chat-session", useChatSessionStore),
      installStorePressureProbe("turn", useTurnStore),
      installStorePressureProbe("composer", useComposerStore),
      installStorePressureProbe("interaction", useInteractionStore),
      installStorePressureProbe("viewer", useViewerStore),
      installStorePressureProbe("conversation", useConversationStore),
      installStorePressureProbe("voice-recording", useVoiceRecordingStore),
      installStorePressureProbe("subagent", useSubagentStore),
      installStorePressureProbe("workflow", useWorkflowStore),
    ];
    return () => {
      for (const stop of uninstall) {
        stop();
      }
    };
  }, []);
}
