
import { ChevronRight, type LucideIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { Fragment } from "react";

import { SideMenu } from "@/components/app/core/SideMenu/SideMenu.js";

/** A single flat item in the settings sidebar. */
export interface SettingsSidebarItem {
  /** Unique identifier used to track and set the active panel. */
  id: string;
  /** Display label shown in the sidebar. */
  label: string;
  /** Route path used for Link-based navigation. */
  href: string;
  /** Lucide icon component rendered beside the label. */
  icon: LucideIcon;
}

interface SettingsSidebarTreeProps {
  /** Flat list of navigation items to render. */
  items: SettingsSidebarItem[];
  /** Optional items pinned to the bottom of the sidebar, separated by a divider. */
  bottomItems?: SettingsSidebarItem[];
}

/**
 * Settings nav rows. Desktop reuses the assistant sidebar's `SideMenu.Item`
 * primitive directly (no surrounding `<SideMenu>` shell — its outer chrome
 * would fight the SettingsShell panel background) so the two sidebar
 * surfaces are byte-for-byte identical, including the neutral
 * `--surface-active` highlight on the selected row.
 *
 * Mobile follows Figma node 2883:11116: a 1px divider between rows with
 * a right-aligned chevron on each row, in place of the spacing + active
 * highlight used on desktop. The mobile menu is only ever shown at the
 * settings/logs root (drilling into a sub-page navigates away), so the
 * active highlight has no role there anyway.
 */
export function SettingsSidebarTree({ items, bottomItems }: SettingsSidebarTreeProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const renderItem = (item: SettingsSidebarItem, isLast: boolean) => {
    const isActive =
      pathname === item.href || pathname.startsWith(item.href + "/");
    return (
      <Fragment key={item.id}>
        <SideMenu.Item
          icon={item.icon}
          label={item.label}
          active={isActive}
          trailingIcon={ChevronRight}
          trailingIconClassName="md:hidden"
          onSelect={() => navigate(item.href)}
        />
        {!isLast && (
          <div
            role="presentation"
            aria-hidden
            className="my-2 h-px w-full bg-[var(--border-base)] md:hidden"
          />
        )}
      </Fragment>
    );
  };

  return (
    <nav
      aria-label="Settings navigation"
      className="flex min-h-full flex-col md:gap-2 md:px-6 md:pb-4"
    >
      {items.map((item, index) =>
        renderItem(item, index === items.length - 1 && !bottomItems?.length),
      )}

      {bottomItems && bottomItems.length > 0 && (
        <>
          <div className="flex-1" />
          <div
            role="presentation"
            aria-hidden
            className="mx-0 my-2 h-px w-full bg-[var(--border-base)] md:mx-0"
          />
          {bottomItems.map((item, index) =>
            renderItem(item, index === bottomItems.length - 1),
          )}
        </>
      )}
    </nav>
  );
}
