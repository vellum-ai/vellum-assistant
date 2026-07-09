import { ChevronRight, type LucideIcon } from "lucide-react";
import { Fragment } from "react";
import { useLocation, useNavigate } from "react-router";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { SideMenu } from "@vellumai/design-library";

export interface SidebarItem {
  id: string;
  label: string;
  /** Navigation target. Omit for action items, which supply `onSelect` instead. */
  href?: string;
  icon: LucideIcon;
  /** Action items (e.g. Log Out) run this instead of navigating. Rendered as a
   *  button with no trailing chevron and never marked active. */
  onSelect?: () => void;
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
  const isMobile = useIsMobile();

  const renderItem = (item: SidebarItem, isLast: boolean, isIndexItem: boolean) => {
    const { href, onSelect } = item;
    const isActive =
      href != null &&
      (pathname === href ||
        pathname.startsWith(href + "/") ||
        (!isMobile && isIndexItem && indexPath != null && pathname === indexPath));
    return (
      <Fragment key={item.id}>
        <SideMenu.Item
          icon={item.icon}
          label={item.label}
          active={isActive}
          // Action items (no href) render as a button; the chevron would
          // wrongly read as "navigates to a page", so omit it for them.
          trailingIcon={href != null ? ChevronRight : undefined}
          trailingIconClassName={href != null ? "md:hidden" : undefined}
          href={href}
          onSelect={onSelect}
          onClick={
            href == null
              ? undefined
              : (e) => {
                  // Modifier and middle clicks fall through to the native <a>
                  // so Cmd/Ctrl-click opens a new tab, Shift-click opens a
                  // window, and "Copy link address" works. Plain left-clicks
                  // become SPA navigation via react-router.
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
                  navigate(href);
                }
          }
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
