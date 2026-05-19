// TODO: port from platform
import type { ComponentType, ReactNode } from "react";

export interface CommandPaletteItemData {
  id: string;
  label?: string;
  title: string;
  subtitle?: string;
  icon?: ComponentType | string;
  shortcutHint?: string;
  action?: () => void;
}

export interface CommandPaletteSection {
  id: string;
  label: string;
  items: CommandPaletteItemData[];
}

export function CommandPalette(_props: { sections?: CommandPaletteSection[]; children?: ReactNode }): ReactNode { return null; }
