import { useCallback, useState } from "react";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";

export function useEditMessage(messages: DisplayMessage[]) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const startEditing = useCallback((): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && !m.queueStatus && !m.isOptimistic) {
        setEditingMessageId(m.id);
        return messagePlainText(m);
      }
    }
    return null;
  }, [messages]);

  const cancelEditing = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  return { editingMessageId, isEditing: editingMessageId !== null, startEditing, cancelEditing } as const;
}
