import { useCallback } from "react";

import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

export type ActionDisplayKey =
  | "click"
  | "type"
  | "keyPress"
  | "scroll"
  | "drag"
  | "hover"
  | "observe"
  | "navigate"
  | "terminal";

export const ACTION_DISPLAY_TRANSLATION_KEYS = {
  click: "actionDisplay.click",
  type: "actionDisplay.type",
  keyPress: "actionDisplay.keyPress",
  scroll: "actionDisplay.scroll",
  drag: "actionDisplay.drag",
  hover: "actionDisplay.hover",
  observe: "actionDisplay.observe",
  navigate: "actionDisplay.navigate",
  terminal: "actionDisplay.terminal",
} as const satisfies Record<ActionDisplayKey, string>;

type ActionDisplayTranslationKey =
  (typeof ACTION_DISPLAY_TRANSLATION_KEYS)[ActionDisplayKey];

export function resolveActionDisplayLabel(
  input: {
    activity?: string | null;
    actionDisplayKey?: ActionDisplayKey | null;
    fallback?: string | null;
  },
  translate: (key: ActionDisplayTranslationKey) => string,
  sessionGroupsEnabled: boolean,
): string {
  if (!sessionGroupsEnabled) {
    return input.fallback ?? "";
  }
  if (input.activity) {
    return input.activity;
  }
  if (input.actionDisplayKey) {
    return translate(ACTION_DISPLAY_TRANSLATION_KEYS[input.actionDisplayKey]);
  }
  return input.fallback ?? "";
}

export function useActionDisplayLabel() {
  const { t } = useTranslation("chat");
  const sessionGroupsEnabled = useAssistantFeatureFlagStore.use.sessionGroups();
  return useCallback(
    (input: Parameters<typeof resolveActionDisplayLabel>[0]) =>
      resolveActionDisplayLabel(input, t, sessionGroupsEnabled),
    [sessionGroupsEnabled, t],
  );
}
