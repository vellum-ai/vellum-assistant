/**
 * Side-drawer detail panel for an ACP run — renders the run as a Devin-style
 * chat conversation via `AcpRunChatView`.
 */

import { AcpRunChatView } from "@/domains/chat/components/acp-run-chat-view/acp-run-chat-view";
import { type AcpRunEntry } from "@/domains/chat/acp-run-store";

export interface AcpRunDetailPanelProps {
  entry: AcpRunEntry;
  onClose: () => void;
}

export function AcpRunDetailPanel({ entry, onClose }: AcpRunDetailPanelProps) {
  return <AcpRunChatView entry={entry} onClose={onClose} />;
}
