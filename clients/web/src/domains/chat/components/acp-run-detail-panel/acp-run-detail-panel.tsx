/**
 * Side-drawer detail panel for an ACP run — renders the run as a Devin-style
 * chat conversation via `AcpRunChatView`.
 */

import { AcpRunChatView } from "@/domains/chat/components/acp-run-chat-view/acp-run-chat-view";
import { type AcpRunEntry } from "@/domains/chat/acp-run-store";

export interface AcpRunDetailPanelProps {
  entry: AcpRunEntry;
  onClose: () => void;
  /** Assistant that owns the run's parent conversation. */
  assistantId?: string | null;
}

export function AcpRunDetailPanel({
  entry,
  onClose,
  assistantId,
}: AcpRunDetailPanelProps) {
  return (
    <AcpRunChatView entry={entry} onClose={onClose} assistantId={assistantId} />
  );
}
