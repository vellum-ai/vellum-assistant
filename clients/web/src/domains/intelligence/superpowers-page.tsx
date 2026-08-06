import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { SuperpowersTab } from "@/domains/intelligence/components/superpowers/superpowers-tab";

/**
 * The My Superpowers page (`/assistant/superpowers`) — skills and plugins
 * combined into one list. The legacy `/assistant/skills` and
 * `/assistant/plugins` list routes redirect here with their query params
 * preserved (see `skills-page.tsx` / `plugins-page.tsx`).
 */
export function SuperpowersPage() {
  const assistantId = useActiveAssistantId();
  return <SuperpowersTab assistantId={assistantId} />;
}
