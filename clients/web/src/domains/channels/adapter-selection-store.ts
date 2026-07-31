/**
 * Which adapter's detail is shown in the Channels tab's master-detail layout.
 *
 * Kept in a module-level store rather than component state so the choice
 * survives the tab's route remounting (navigating away to another About
 * Assistant section and back) — the selection persists for the browser
 * session and resets to Slack on a full reload. Slack is the default so the
 * tab opens on the primary adapter.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { SetupChannelId } from "@/types/channel-types";

export interface ChannelAdapterSelectionState {
  selectedAdapter: SetupChannelId;
}

export interface ChannelAdapterSelectionActions {
  selectAdapter: (adapter: SetupChannelId) => void;
}

export type ChannelAdapterSelectionStore = ChannelAdapterSelectionState &
  ChannelAdapterSelectionActions;

const useChannelAdapterSelectionStoreBase =
  create<ChannelAdapterSelectionStore>()((set) => ({
    selectedAdapter: "slack",
    selectAdapter: (adapter) => set({ selectedAdapter: adapter }),
  }));

export const useChannelAdapterSelectionStore = createSelectors(
  useChannelAdapterSelectionStoreBase,
);
