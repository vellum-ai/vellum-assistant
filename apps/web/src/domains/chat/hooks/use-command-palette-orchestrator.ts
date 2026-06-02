/**
 * useCommandPaletteOrchestrator — owns the navigateToSettings callback
 * and delegates to useCommandPaletteSections for section data and item
 * dispatch. The Ctrl/Cmd+K shortcut lives in ChatLayout alongside
 * other layout-level keyboard shortcuts.
 */

import { useCallback } from "react";
import { useNavigate } from "react-router";

import type { Conversation } from "@/types/conversation-types";
import { routes } from "@/utils/routes";
import {
  useCommandPaletteSections,
  type UseCommandPaletteSectionsReturn,
} from "@/domains/chat/hooks/use-command-palette-sections";

export interface UseCommandPaletteOrchestratorOptions {
  assistantId: string | null;
  assistantName: string | undefined;
  conversations: Conversation[];
  activeConversationId: string | undefined;
  startNewConversation: () => void;
  switchConversation: (key: string) => void;
}

export type UseCommandPaletteOrchestratorReturn = UseCommandPaletteSectionsReturn;

export function useCommandPaletteOrchestrator({
  assistantId,
  assistantName,
  conversations,
  activeConversationId,
  startNewConversation,
  switchConversation,
}: UseCommandPaletteOrchestratorOptions): UseCommandPaletteOrchestratorReturn {
  const navigate = useNavigate();
  const navigateToSettings = useCallback(() => {
    void navigate(routes.settings.root);
  }, [navigate]);

  return useCommandPaletteSections({
    assistantId,
    assistantName,
    conversations,
    activeConversationId,
    startNewConversation,
    switchConversation,
    navigate: (to: string | number) => {
      if (typeof to === "number") navigate(to);
      else void navigate(to);
    },
    navigateToSettings,
  });
}
