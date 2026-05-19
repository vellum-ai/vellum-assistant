// TODO: port from platform
import type { ReactNode } from "react";

export interface PanelItemProps {
  children?: ReactNode;
  asChild?: boolean;
  active?: boolean;
  label?: string;
  [key: string]: unknown;
}
export function PanelItem({ children }: PanelItemProps): ReactNode { return children ?? null; }
