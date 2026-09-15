import { Button } from "@vellumai/design-library";
import { ChevronsRight, Monitor } from "lucide-react";

import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { useDesktopSidebarStore } from "./desktop-sidebar-store";

export function AssistantDesktopAffordance() {
  const { t } = useTranslation("chat");
  const enabled = useAssistantFeatureFlagStore.use.assistantDesktop();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const session = useDesktopSidebarStore.use.session();

  if (enabled !== true || assistantId === null) {
    return null;
  }

  const open = session?.assistantId === assistantId;
  const label = open
    ? t("assistantDesktop.collapseAria")
    : t("assistantDesktop.openAria");

  return (
    <Button
      variant="ghost"
      iconOnly={open ? <ChevronsRight /> : <Monitor />}
      aria-label={label}
      tooltip={label}
      aria-expanded={open}
      aria-controls="assistant-desktop-sidebar"
      onClick={() => useDesktopSidebarStore.getState().toggle(assistantId)}
    />
  );
}
