// TODO: port from platform
import type { ReactNode } from "react";

export interface ConversationStarterGridProps {
  starters?: Array<{ prompt: string }>;
  onSelect?: (starter: { prompt: string }) => void;
  children?: ReactNode;
}
export function ConversationStarterGrid(_props: ConversationStarterGridProps) { return null; }
