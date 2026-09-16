import { Button } from "@vellumai/design-library";
import { Monitor } from "lucide-react";

import { useAssistantName } from "@/hooks/use-assistant-name";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { usePointerCoarse } from "@/utils/pointer";

import { useDesktopPreviewStore } from "./desktop-preview-store";
import { useVirtualDesktopEnabled } from "./use-virtual-desktop-enabled";

export function AssistantDesktopAffordance({
  onToggle,
}: {
  onToggle?: () => void;
}) {
  const { t } = useTranslation("chat");
  const enabled = useVirtualDesktopEnabled();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantName = useAssistantName(assistantId);
  const session = useDesktopPreviewStore.use.session();
  const fullscreenOnly = usePointerCoarse();

  if (enabled !== true || assistantId === null) {
    return null;
  }

  const open = session?.assistantId === assistantId;
  const label = open
    ? t("assistantDesktop.hideAria")
    : assistantName
      ? t("assistantDesktop.openAria", { name: assistantName })
      : t("assistantDesktop.openUnnamedAria");

  return (
    <Button
      variant="ghost"
      active={open}
      iconOnly={<Monitor />}
      aria-label={label}
      tooltip={label}
      aria-expanded={open}
      aria-controls={
        fullscreenOnly ? "assistant-desktop-modal" : "assistant-desktop-preview"
      }
      onClick={() => {
        useDesktopPreviewStore.getState().toggle(assistantId);
        onToggle?.();
      }}
    />
  );
}
