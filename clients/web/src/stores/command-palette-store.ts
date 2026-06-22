/**
 * Minimal visibility store for the command palette.
 *
 * Owns only the open/close state so layout-level UI (the search button
 * in ChatLayoutHeader, the Ctrl/Cmd+K shortcut) can toggle the palette
 * without waiting for a child route to mount and register a callback.
 *
 * Search-specific state (query, selectedIndex, results) stays local to
 * `useCommandPalette` — it resets whenever `isOpen` transitions to false.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface CommandPaletteState {
  isOpen: boolean;
}

interface CommandPaletteActions {
  open: () => void;
  close: () => void;
  toggle: () => void;
}

type CommandPaletteStore = CommandPaletteState & CommandPaletteActions;

const useCommandPaletteStoreBase = create<CommandPaletteStore>((set, get) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set({ isOpen: !get().isOpen }),
}));

export const useCommandPaletteStore = createSelectors(
  useCommandPaletteStoreBase,
);
