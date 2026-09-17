import { useActiveAssistantIsPlatformHosted } from "@/hooks/use-platform-gate";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

export function useVirtualDesktopEnabled(): boolean {
  const enabled = useAssistantFeatureFlagStore.use.assistantDesktop();
  const platformHosted = useActiveAssistantIsPlatformHosted();
  return enabled === true && platformHosted;
}
