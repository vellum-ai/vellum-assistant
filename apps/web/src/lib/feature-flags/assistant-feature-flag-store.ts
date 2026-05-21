import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import { client } from "@/generated/api/client.gen.js";
import { ASSISTANT_FLAG_DEFAULTS, storeKeyToLdKey } from "@/lib/feature-flags/feature-flag-catalog.js";

interface AssistantFeatureFlagActions {
  assistantId: string | null;
  setAssistantId: (id: string | null) => void;
  setFlags: (flags: Record<string, boolean>) => void;
  setFlag: (key: string, value: boolean) => void;
}

type AssistantFeatureFlagStore = Record<string, boolean> &
  AssistantFeatureFlagActions;

const useAssistantFeatureFlagStoreBase = create<AssistantFeatureFlagStore>()(
  (set, get) =>
    ({
      ...ASSISTANT_FLAG_DEFAULTS,
      assistantId: null,

      setAssistantId: (id: string | null) => set({ assistantId: id }),

      setFlags: (flags: Record<string, boolean>) =>
        set((prev) => {
          const changed = Object.keys(flags).some(
            (k) => flags[k] !== prev[k],
          );
          return changed ? flags : prev;
        }),

      setFlag: (key: string, value: boolean) => {
        set({ [key]: value });

        const { assistantId } = get();
        const ldKey = storeKeyToLdKey(key);
        if (assistantId && ldKey) {
          void client.patch({
            url: `/v1/assistants/${assistantId}/feature-flags/${ldKey}`,
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
