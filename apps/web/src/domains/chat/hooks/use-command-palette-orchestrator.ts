/**
 * useCommandPaletteOrchestrator — owns the Ctrl/Cmd+K shortcut, the
 * navigateToSettings callback, and delegates to useCommandPaletteSections
 * for section data and item dispatch.
 *
 * Returns everything ActiveChatView needs for both header registration
 * (toggle) and rendering (isOpen, sections, handlers).
 */

import { useCallback, useEffect } from "react";
import type { NavigateFunction } from "react-router";

import type { Conversation } from "@/types/conversation-types";
import { routes } from "@/utils/routes";
import { shouldHandleShortcut } from "@/domains/chat/chat-layout";
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
  navigate: NavigateFunction;
}

export type UseCommandPaletteOrchestratorReturn = UseCommandPaletteSectionsReturn;

export function useCommandPaletteOrchestrator({
  assistantId,
  assistantName,
  conversations,
  activeConversationId,
  startNewConversation,
  switchConversation,
  navigate,
}: UseCommandPaletteOrchestratorOptions): UseCommandPaletteOrchestratorReturn {
  const navigateToSettings = useCallback(() => {
    void navigate(routes.settings.root);
  }, [navigate]);

  const result = useCommandPaletteSections({
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

  // Ctrl/Cmd+K shortcut for command palette
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, "k")) return;
      event.preventDefault();
      result.commandPalette.toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [result.commandPalette.toggle]);

  return result;
}
