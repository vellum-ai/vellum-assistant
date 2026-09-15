import { Button } from "@vellumai/design-library";
import { Monitor } from "lucide-react";

import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { useDesktopPreviewStore } from "./desktop-preview-store";

export function AssistantDesktopAffordance() {
  const { t } = useTranslation("chat");
  const enabled = useAssistantFeatureFlagStore.use.assistantDesktop();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const session = useDesktopPreviewStore.use.session();

  if (enabled !== true || assistantId === null) {
    return null;
  }

  const open = session?.assistantId === assistantId;
  const label = open
    ? t("assistantDesktop.hideAria")
    : t("assistantDesktop.openAria");

  return (
    <Button
      variant="ghost"
      active={open}
      iconOnly={<Monitor />}
      aria-label={label}
      tooltip={label}
      aria-expanded={open}
      aria-controls="assistant-desktop-preview"
      onClick={() => useDesktopPreviewStore.getState().toggle(assistantId)}
    />
  );
}
