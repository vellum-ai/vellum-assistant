/**
 * A column of sidebar nav entries.
 *
 * Centred on the rail so the circles share one icon axis, left-aligned when
 * expanded so the pills start at the sidebar's edge. The entries themselves
 * are {@link SidebarNavPill}, which decides its own shape.
 */

import {
  SidebarNavPill,
  type SidebarNavPillProps,
} from "@/domains/chat/components/sidebar-nav-pill";

export interface SidebarNavPillListProps {
  entries: Array<SidebarNavPillProps & { key: string }>;
  /** Draw the entries as circles rather than pills. */
  collapsed?: boolean;
}

export function SidebarNavPillList({
  entries,
  collapsed = false,
}: SidebarNavPillListProps) {
  return (
    <div
      className={
        collapsed
          ? "flex flex-col items-center gap-2"
          : "flex flex-col items-start gap-1"
      }
    >
      {entries.map(({ key, ...entry }) => (
        <SidebarNavPill key={key} {...entry} collapsed={collapsed} />
      ))}
    </div>
  );
}
