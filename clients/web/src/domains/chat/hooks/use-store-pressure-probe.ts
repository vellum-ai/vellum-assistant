import { useEffect } from "react";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useCompanionPopoverStore } from "@/domains/chat/companion-popover";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { installStorePressureProbe } from "@/lib/commit-pressure";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";

/**
 * Tallies the chat route's store writes into the commit-pressure probe for as
 * long as the route is mounted, the same span `recordCommit` counts commits
 * over.
 *
 * Two groups of stores. The ones the stream path writes (from
 * `utils/stream-handlers/`, `streaming/sse-event-consumer.ts`,
 * `use-event-stream.ts` and `use-stream-event-handler.ts`; stores it only
 * reads, such as identity and the resolved assistants, are left out), because
 * a stream writes them at the rate events arrive. And the two a user drives
 * at input rate: the composer draft and the mirrored microphone level. A
 * store left out is not misreported; its commits read as they did before
 * this hook.
 */
export function useStorePressureProbe(): void {
  useEffect(() => {
    const uninstall = [
      installStorePressureProbe("chat-session", useChatSessionStore),
      installStorePressureProbe("subagent", useSubagentStore),
      installStorePressureProbe("interaction", useInteractionStore),
      installStorePressureProbe("conversation", useConversationStore),
      installStorePressureProbe("workflow", useWorkflowStore),
      installStorePressureProbe("viewer", useViewerStore),
      installStorePressureProbe("stream", useStreamStore),
      installStorePressureProbe("acp-run", useAcpRunStore),
      installStorePressureProbe("turn", useTurnStore),
      installStorePressureProbe("background-task", useBackgroundTaskStore),
      installStorePressureProbe("companion-popover", useCompanionPopoverStore),
      installStorePressureProbe("composer", useComposerStore),
      installStorePressureProbe("voice-recording", useVoiceRecordingStore),
    ];
    return () => {
      for (const stop of uninstall) {
        stop();
      }
    };
  }, []);
}
