import { type ReactNode } from "react";
import { NavLink } from "react-router";
import { House, Library, MessageSquare, Settings, X } from "lucide-react";
import { Button } from "@vellum/design-library";

import type { SideMenuRenderArgs } from "./chat-layout.js";

function NavItem({
  to,
  icon,
  label,
  collapsed,
  onClick,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  collapsed: boolean;
  onClick?: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        [
          "flex items-center gap-3 rounded-lg px-3 py-2 text-body-small-default transition-colors",
          isActive
            ? "bg-[var(--surface-lift)]"
            : "hover:bg-[var(--surface-lift)]",
          collapsed ? "justify-center" : "",
        ]
          .filter(Boolean)
          .join(" ")
      }
      style={{ color: "var(--content-default)" }}
    >
      <span className="shrink-0">{icon}</span>
      {!collapsed ? <span>{label}</span> : null}
    </NavLink>
  );
}

export function SideMenu({ collapsed, variant, onClose }: SideMenuRenderArgs) {
  const isOverlay = variant === "overlay";
  const handleNavClick = isOverlay ? onClose : undefined;

  return (
    <nav
      data-slot="side-menu"
      className="flex flex-col gap-1 p-2"
      style={{
        width: isOverlay ? "100%" : collapsed ? 52 : 240,
        transition: "width 150ms ease-in-out",
      }}
    >
      {isOverlay ? (
        <div className="flex items-center justify-between px-2 pb-2">
          <span
            className="text-title-small"
            style={{ color: "var(--content-default)" }}
          >
            Vellum
          </span>
          <Button
            variant="ghost"
            iconOnly={<X />}
            aria-label="Close navigation"
            onClick={onClose}
          />
        </div>
      ) : null}

      <NavItem
        to="/home"
        icon={<House size={18} />}
        label="Home"
        collapsed={collapsed}
        onClick={handleNavClick}
      />
      <NavItem
        to="/"
        icon={<MessageSquare size={18} />}
        label="Chat"
        collapsed={collapsed}
        onClick={handleNavClick}
      />
      <NavItem
        to="/library"
        icon={<Library size={18} />}
        label="Library"
        collapsed={collapsed}
        onClick={handleNavClick}
      />
      <NavItem
        to="/settings/general"
        icon={<Settings size={18} />}
        label="Settings"
        collapsed={collapsed}
        onClick={handleNavClick}
      />
    </nav>
  );
}
