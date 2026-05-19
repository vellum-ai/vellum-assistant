import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  House,
  Menu as MenuIcon,
  MessageSquarePlus,
  PanelLeft,
  Search,
} from "lucide-react";
import { Button } from "@vellum/design-library";

export interface ChatLayoutHeaderProps {
  isMobile: boolean;
  drawerOpen: boolean;
  collapsed: boolean;
  toggleSidebar: () => void;
  topBarCenter?: ReactNode;
  topBarRightSlot?: ReactNode;
  onStartNewConversation?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onSearchClick?: () => void;
  onOpenHome?: () => void;
  isHomeActive?: boolean;
}

export function ChatLayoutHeader({
  isMobile,
  drawerOpen,
  collapsed,
  toggleSidebar,
  topBarCenter,
  topBarRightSlot,
  onStartNewConversation,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onSearchClick,
  onOpenHome,
  isHomeActive,
}: ChatLayoutHeaderProps) {
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
        className="flex items-center gap-2 transition-[min-width] duration-150 ease-in-out"
        style={!isMobile ? { minWidth: collapsed ? 48 : 230 } : undefined}
      >
        {isMobile ? (
          <Button
            variant="ghost"
            iconOnly={<MenuIcon />}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="chat-side-menu"
            onClick={toggleSidebar}
          />
        ) : (
          <Button
            variant="ghost"
            iconOnly={<PanelLeft />}
            aria-label="Toggle sidebar"
            aria-expanded={!collapsed}
            aria-controls="chat-side-menu"
            onClick={toggleSidebar}
          />
        )}
        {!isMobile ? (
          <>
            {onOpenHome ? (
              <Button
                variant="ghost"
                iconOnly={<House />}
                aria-label="Home"
                aria-current={isHomeActive ? "page" : undefined}
                onClick={onOpenHome}
              />
            ) : null}
            {onSearchClick ? (
              <Button
                variant="ghost"
                iconOnly={<Search />}
                aria-label="Search (Ctrl+K)"
                title="Search (Ctrl+K)"
                onClick={onSearchClick}
              />
            ) : null}
            <Button
              variant="ghost"
              iconOnly={<ChevronLeft />}
              aria-label="Back (Ctrl+[)"
              title="Back (Ctrl+[)"
              disabled={!canGoBack}
              className={!canGoBack ? "opacity-35" : undefined}
              onClick={onGoBack}
            />
            <Button
              variant="ghost"
              iconOnly={<ChevronRight />}
              aria-label="Forward (Ctrl+])"
              title="Forward (Ctrl+])"
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

      <div className="flex items-center gap-2">
        {isMobile && onSearchClick ? (
          <Button
            variant="ghost"
            iconOnly={<Search />}
            aria-label="Search (Ctrl+K)"
            title="Search (Ctrl+K)"
            onClick={onSearchClick}
          />
        ) : null}
        {onStartNewConversation ? (
          <Button
            variant="ghost"
            iconOnly={<MessageSquarePlus />}
            aria-label="New conversation"
            onClick={onStartNewConversation}
          />
        ) : null}
        {topBarRightSlot}
      </div>
    </header>
  );
}
