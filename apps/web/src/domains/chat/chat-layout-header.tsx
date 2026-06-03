import { useCallback, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  House,
  Menu as MenuIcon,
  PanelLeft,
  Search,
} from "lucide-react";
import { Button } from "@vellum/design-library";

import { useCommandPaletteStore } from "@/stores/command-palette-store";

export interface ChatLayoutHeaderProps {
  isMobile: boolean;
  drawerOpen: boolean;
  collapsed: boolean;
  sidebarWidth?: number;
  toggleSidebar: () => void;
  topBarCenter?: ReactNode;
  topBarRightSlot?: ReactNode;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onOpenHome?: () => void;
  isHomeActive?: boolean;
  hasUnreadHome?: boolean;
}

export function ChatLayoutHeader({
  isMobile,
  drawerOpen,
  collapsed,
  sidebarWidth,
  toggleSidebar,
  topBarCenter,
  topBarRightSlot,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onOpenHome,
  isHomeActive,
  hasUnreadHome,
}: ChatLayoutHeaderProps) {
  const toggleCommandPalette = useCommandPaletteStore.use.toggle();
  const handleSearchClick = useCallback(() => { toggleCommandPalette(); }, [toggleCommandPalette]);

  return (
    <header
      data-slot="chat-layout-header"
      className={`flex w-full shrink-0 items-center gap-4 px-4 pt-4${isMobile ? " pb-4" : ""}`}
      style={{
        background: "var(--surface-base)",
        minHeight:
          "calc(40px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
        paddingTop:
          "calc(16px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
      }}
    >
      <div
        className="flex items-center gap-2 transition-[min-width] duration-150 ease-in-out max-md:min-w-0 max-md:flex-1"
        style={!isMobile ? { minWidth: collapsed ? 48 : (sidebarWidth ?? 230) } : undefined}
      >
        {isMobile ? (
          <Button
            variant="ghost"
            iconOnly={<MenuIcon />}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="chat-side-menu"
            tooltip="Open navigation"
            onClick={toggleSidebar}
          />
        ) : (
          <Button
            variant="ghost"
            iconOnly={<PanelLeft />}
            aria-label="Toggle sidebar"
            aria-expanded={!collapsed}
            aria-controls="chat-side-menu"
            tooltip="Toggle sidebar"
            onClick={toggleSidebar}
          />
        )}
        {onOpenHome && !(isMobile && isHomeActive) ? (
          <span className="relative">
            <Button
              variant="ghost"
              iconOnly={<House />}
              aria-label={hasUnreadHome && !isHomeActive ? "Home (unread notifications)" : "Home"}
              aria-current={isHomeActive ? "page" : undefined}
              tooltip="Home"
              onClick={onOpenHome}
            />
            {hasUnreadHome && !isHomeActive ? (
              <span
                className="pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full bg-[var(--system-negative-strong)]"
                aria-hidden="true"
              />
            ) : null}
          </span>
        ) : null}
        {!isMobile ? (
          <>
            <Button
              variant="ghost"
              iconOnly={<Search />}
              aria-label="Search (Ctrl+K)"
              tooltip="Search (Ctrl+K)"
              onClick={handleSearchClick}
            />
            <Button
              variant="ghost"
              iconOnly={<ChevronLeft />}
              aria-label="Back (Ctrl+[)"
              tooltip="Back (Ctrl+[)"
              disabled={!canGoBack}
              className={!canGoBack ? "opacity-35" : undefined}
              onClick={onGoBack}
            />
            <Button
              variant="ghost"
              iconOnly={<ChevronRight />}
              aria-label="Forward (Ctrl+])"
              tooltip="Forward (Ctrl+])"
              disabled={!canGoForward}
              className={!canGoForward ? "opacity-35" : undefined}
              onClick={onGoForward}
            />
          </>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center">
        {topBarCenter}
      </div>

      <div className="flex items-center gap-2 max-md:flex-1 max-md:justify-end">
        {isMobile ? (
          <Button
            variant="ghost"
            iconOnly={<Search />}
            aria-label="Search (Ctrl+K)"
            tooltip="Search (Ctrl+K)"
            onClick={handleSearchClick}
          />
        ) : null}
        {topBarRightSlot}
      </div>
    </header>
  );
}
