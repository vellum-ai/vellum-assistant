/**
 * Renders the `AcpConnectAffordance` above the composer when its anchor tool
 * call has scrolled into history, reading placement from
 * {@link useAcpConnectPlacement}. While the anchor's turn is still the last in
 * the thread the card renders inline instead, under the tool call that failed.
 */

import { AcpConnectAffordance } from "@/domains/chat/transcript/acp-connect-affordance";
import { useAcpConnectPlacement } from "@/domains/chat/hooks/use-acp-connect-placement";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export function AcpConnectSlot() {
  const placement = useAcpConnectPlacement();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  if (placement !== "docked") {
    return null;
  }

  return (
    <div className="mb-2">
      <AcpConnectAffordance assistantId={assistantId} />
    </div>
  );
}
