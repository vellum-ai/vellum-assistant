import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import { client } from "@/generated/api/client.gen.js";
import { ASSISTANT_FLAG_DEFAULTS, storeKeyToLdKey } from "@/lib/feature-flags/feature-flag-catalog.js";

let currentAssistantId: string | null = null;

interface AssistantFeatureFlagActions {
  setFlags: (flags: Record<string, boolean>) => void;
  setFlag: (key: string, value: boolean) => void;
}

type AssistantFeatureFlagStore = Record<string, boolean> &
  AssistantFeatureFlagActions;

const useAssistantFeatureFlagStoreBase = create<AssistantFeatureFlagStore>()(
  (set) =>
    ({
      ...ASSISTANT_FLAG_DEFAULTS,

      setFlags: (flags: Record<string, boolean>) =>
        set((prev) => {
          const changed = Object.keys(flags).some(
            (k) => flags[k] !== prev[k],
          );
          return changed ? flags : prev;
        }),

      setFlag: (key: string, value: boolean) => {
        set({ [key]: value });

        const ldKey = storeKeyToLdKey(key);
        if (currentAssistantId && ldKey) {
          void client.patch({
            url: `/v1/assistants/${currentAssistantId}/feature-flags/${ldKey}`,
            body: { enabled: value },
            throwOnError: false,
          } as Parameters<typeof client.patch>[0]);
        }
      },
    }) as AssistantFeatureFlagStore,
);

export const useAssistantFeatureFlagStore = createSelectors(
  useAssistantFeatureFlagStoreBase,
);

export function setAssistantIdForFlags(id: string | null) {
  currentAssistantId = id;
}
