// TODO: port from platform
import type { ReactNode } from "react";

function PopoverRoot(_props: { children?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) { return null; }
function PopoverAnchor(_props: { children?: ReactNode; [key: string]: unknown }) { return null; }
function PopoverContent(_props: { children?: ReactNode; [key: string]: unknown }) { return null; }

export const Popover = Object.assign(PopoverRoot, {
  Root: PopoverRoot,
  Anchor: PopoverAnchor,
  Content: PopoverContent,
});
