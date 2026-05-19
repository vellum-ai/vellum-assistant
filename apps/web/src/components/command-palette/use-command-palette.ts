// TODO: port from platform
import type { GlobalSearchResponse } from "@/domains/chat/lib/global-search.js";

import type { CommandPaletteSection } from "./command-palette.js";

export interface UseCommandPaletteOptions {
  itemCount?: () => number;
  onSelect?: (index: number) => void;
  assistantId?: string | null;
}

export interface UseCommandPaletteReturn {
  open: boolean;
  setOpen: (open: boolean) => void;
  close: () => void;
  query: string;
  searchResults: GlobalSearchResponse;
  sections: CommandPaletteSection[];
  setSections: (sections: CommandPaletteSection[]) => void;
}

export function useCommandPalette(_opts?: UseCommandPaletteOptions): UseCommandPaletteReturn {
  return {
    open: false,
    setOpen: () => {},
    close: () => {},
    query: "",
    searchResults: { conversations: [], schedules: [], contacts: [] },
    sections: [],
    setSections: () => {},
  };
}
