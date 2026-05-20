import { ChevronRight, type LucideIcon } from "lucide-react";
import { Fragment } from "react";
import { NavLink } from "react-router";

export interface SettingsSidebarItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

interface SettingsSidebarTreeProps {
  items: SettingsSidebarItem[];
  bottomItems?: SettingsSidebarItem[];
}

function SidebarNavItem({
  item,
  isLast,
}: {
  item: SettingsSidebarItem;
  isLast: boolean;
}) {
  const Icon = item.icon;

  return (
    <Fragment>
      <NavLink
        to={item.href}
        end={false}
        className={({ isActive }) =>
          [
            "flex items-center gap-3 rounded-lg px-3 py-2 text-body-small-default transition-colors",
            isActive
              ? "bg-[var(--surface-active)]"
              : "hover:bg-[var(--surface-lift)]",
          ].join(" ")
        }
        style={{ color: "var(--content-default)" }}
      >
        <Icon size={18} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <ChevronRight
          size={16}
          className="shrink-0 text-[var(--content-tertiary)] md:hidden"
          aria-hidden
        />
      </NavLink>
      {!isLast && (
        <div
          role="presentation"
          aria-hidden
          className="my-2 h-px w-full bg-[var(--border-base)] md:hidden"
        />
      )}
    </Fragment>
  );
}

export function SettingsSidebarTree({
  items,
  bottomItems,
}: SettingsSidebarTreeProps) {
  return (
    <nav
      aria-label="Settings navigation"
      className="flex min-h-full flex-col md:gap-2 md:px-6 md:pb-4"
    >
      {items.map((item, index) => (
        <SidebarNavItem
          key={item.id}
          item={item}
          isLast={index === items.length - 1 && !bottomItems?.length}
        />
      ))}

      {bottomItems && bottomItems.length > 0 && (
        <>
          <div className="flex-1" />
          <div
            role="presentation"
            aria-hidden
            className="mx-0 my-2 h-px w-full bg-[var(--border-base)] md:mx-0"
          />
          {bottomItems.map((item, index) => (
            <SidebarNavItem
              key={item.id}
              item={item}
              isLast={index === bottomItems.length - 1}
            />
          ))}
        </>
      )}
    </nav>
  );
}
