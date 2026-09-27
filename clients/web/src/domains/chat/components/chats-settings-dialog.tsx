import type { RefObject } from "react";

import { ChatsSettingsModal } from "@/domains/chat/components/chats-settings-modal";
import { useChatsSettings } from "@/domains/chat/hooks/use-chats-settings";

interface ChatsSettingsDialogProps {
  assistantId: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** Mount for each open session so its draft starts from a fresh config read. */
export function ChatsSettingsDialog({
  assistantId,
  onClose,
  returnFocusRef,
}: ChatsSettingsDialogProps) {
  const settings = useChatsSettings({
    assistantId,
    open: true,
    onSaved: onClose,
  });
  return (
    <ChatsSettingsModal
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      state={settings.state}
      saveStatus={settings.saveStatus}
      onSave={settings.save}
      onRetryLoad={settings.retryLoad}
      returnFocusRef={returnFocusRef}
    />
  );
}
