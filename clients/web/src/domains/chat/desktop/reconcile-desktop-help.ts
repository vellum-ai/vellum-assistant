import { getPendingInteractions } from "@/domains/chat/api/interactions";

import { useDesktopPreviewStore } from "./desktop-preview-store";

export async function reconcileDesktopHelp(assistantId: string): Promise<void> {
  const submitted =
    useDesktopPreviewStore.getState().submittedHelpRequests[assistantId];
  if (!submitted) {
    return;
  }
  try {
    const { pendingQuestion } = await getPendingInteractions(
      assistantId,
      submitted.conversationId,
    );
    if (
      pendingQuestion !== undefined &&
      pendingQuestion?.requestId !== submitted.requestId
    ) {
      useDesktopPreviewStore
        .getState()
        .resolveHelpSubmission(submitted.requestId);
    }
  } catch {
    // Keep input locked until the server confirms resolution.
  }
}
