import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PluginsTab } from "@/domains/intelligence/components/plugins/plugins-tab";

/**
 * Plugins tab for the "About Assistant" pages.
 */
export function PluginsPage() {
  const assistantId = useActiveAssistantId();

  return <PluginsTab assistantId={assistantId} />;
}
