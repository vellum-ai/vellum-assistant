import { ChevronRight, type LucideIcon } from "lucide-react";
import { Fragment } from "react";
import { useLocation, useNavigate } from "react-router";

import { SideMenu } from "@vellumai/design-library";

export interface SidebarItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

interface SidebarTreeProps {
  items: SidebarItem[];
  bottomItems?: SidebarItem[];
  /** When the current pathname matches this path, the first item is marked active.
   *  Handles index routes that render the same page as the first sidebar item
   *  but have a different URL (e.g. /assistant/settings → General page). */
  indexPath?: string;
}

export function SidebarTree({
  items,
  bottomItems,
  indexPath,
}: SidebarTreeProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const renderItem = (item: SidebarItem, isLast: boolean, isIndexItem: boolean) => {
    const isActive =
      pathname === item.href ||
      pathname.startsWith(item.href + "/") ||
      (isIndexItem && indexPath != null && pathname === indexPath);
    return (
      <Fragment key={item.id}>
        <SideMenu.Item
          icon={item.icon}
          label={item.label}
          active={isActive}
          trailingIcon={ChevronRight}
          trailingIconClassName="md:hidden"
          href={item.href}
          onClick={(e) => {
            // Modifier and middle clicks fall through to the native <a> so
            // Cmd/Ctrl-click opens a new tab, Shift-click opens a window,
            // and "Copy link address" works. Plain left-clicks become SPA
            // navigation via react-router.
            if (
              e.metaKey ||
              e.ctrlKey ||
              e.shiftKey ||
              e.altKey ||
              e.button !== 0
            ) {
              return;
            }
            e.preventDefault();
            navigate(item.href);
          }}
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
      aria-label="Sidebar navigation"
      className="flex min-h-full flex-col md:gap-2 md:px-6 md:pb-4"
    >
      {items.map((item, index) =>
        renderItem(item, index === items.length - 1 && !bottomItems?.length, index === 0),
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
            renderItem(item, index === bottomItems.length - 1, false),
          )}
        </>
      )}
    </nav>
  );
}
