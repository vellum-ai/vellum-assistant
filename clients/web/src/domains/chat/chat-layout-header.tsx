import { Button } from "@vellumai/design-library";
import {
    ChevronLeft,
    ChevronRight,
    Menu as MenuIcon,
    PanelLeft,
    Search,
} from "lucide-react";
import { useCallback, useEffect, type ReactNode } from "react";

import { isElectron } from "@/runtime/is-electron";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useTitleBarStore } from "@/stores/title-bar-store";

// On macOS the native window controls (traffic lights) overlay the top-left of
// the renderer. In the Electron shell the header renders as a unified title bar
// sitting *inline* with those controls (the desktop app centres the cluster
// vertically via `MAIN_TRAFFIC_LIGHT_POSITION`), so the left icon row is inset
// to start clear of the ~71px-wide cluster with a comfortable gap after it.
// The header's own `px-4` supplies the first 16px; this adds the remainder
// (≈ button left edge at 96px, leaving a ~25px gap past the green control).
// Off Electron the inset is 0.
const ELECTRON_TRAFFIC_LIGHT_CLEARANCE = 80;

export interface ChatLayoutHeaderProps {
  isMobile: boolean;
  drawerOpen: boolean;
  collapsed: boolean;
  sidebarWidth?: number;
  toggleSidebar: () => void;
  /** Fades out and disables every header control (the in-chat onboarding
   *  prototype's focused stage) while keeping the bar itself for layout
   *  and Electron window dragging. */
  controlsHidden?: boolean;
  /** Fades out just the center chat title (the in-chat onboarding tour,
   *  where the surrounding controls are back but a conversation title over
   *  the narration would compete with it). */
  centerHidden?: boolean;
  /** Dims (not hides) the side control clusters — the tour's walk keeps
   *  them visible for context but pulls them out of the attention field. */
  controlsDimmed?: boolean;
  topBarCenter?: ReactNode;
  topBarRightSlot?: ReactNode;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
}

export function ChatLayoutHeader({
  isMobile,
  drawerOpen,
  collapsed,
  sidebarWidth,
  toggleSidebar,
  controlsHidden = false,
  centerHidden = false,
  controlsDimmed = false,
  topBarCenter,
  topBarRightSlot,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: ChatLayoutHeaderProps) {
  const toggleCommandPalette = useCommandPaletteStore.use.toggle();
  const handleSearchClick = useCallback(() => { toggleCommandPalette(); }, [toggleCommandPalette]);

  // In the Electron shell the header doubles as the macOS title bar: it sits
  // inline with the traffic lights and drives window dragging
  // (`-webkit-app-region: drag`), with its interactive children opting back
  // out via `no-drag`. While mounted it claims the title bar so the global
  // `WindowDragRegion` fallback strip yields (see `useTitleBarStore`) —
  // otherwise that strip, living outside `.app-shell`'s `isolation: isolate`
  // context, would out-stack and swallow clicks on the header's buttons.
  // Gated to Electron so the web/iOS layouts are byte-for-byte unchanged.
  const electron = isElectron();

  const setInlineTitleBarActive =
    useTitleBarStore.use.setInlineTitleBarActive();
  useEffect(() => {
    if (!electron) {
      return;
    }
    setInlineTitleBarActive(true);
    return () => setInlineTitleBarActive(false);
  }, [electron, setInlineTitleBarActive]);

  return (
    <header
      data-slot="chat-layout-header"
      className={`flex w-full shrink-0 items-center gap-4 px-4 pt-4${isMobile && !electron ? " pb-4" : ""}${
        electron
          ? " select-none [-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag]"
          : ""
      }`}
      style={{
        background: "var(--surface-base)",
        minHeight: electron ? "44px" : "40px",
        paddingTop: electron ? 0 : undefined,
      }}
    >
      <div
        // `inert` (not just opacity/pointer-events) so the faded-out
        // controls also leave the tab order and accessibility tree.
        inert={controlsHidden || undefined}
        className={`flex items-center gap-2 transition-[min-width,opacity] duration-300 ease-in-out max-md:min-w-0 max-md:flex-1${controlsHidden ? " pointer-events-none opacity-0" : controlsDimmed ? " opacity-40" : ""}`}
        style={{
          // `minWidth` reserves the sidebar column on desktop only. The Electron
          // inset clears the inline traffic lights regardless of `isMobile` —
          // they stay put even in the narrow mobile layout.
          ...(isMobile ? {} : { minWidth: collapsed ? 48 : (sidebarWidth ?? 230) }),
          ...(electron ? { paddingLeft: ELECTRON_TRAFFIC_LIGHT_CLEARANCE } : {}),
        }}
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

      <div
        inert={controlsHidden || centerHidden || undefined}
        className={`flex min-w-0 flex-1 items-center justify-center transition-opacity duration-300${controlsHidden || centerHidden ? " pointer-events-none opacity-0" : ""}`}
      >
        {topBarCenter}
      </div>

      <div
        inert={controlsHidden || undefined}
        className={`flex items-center gap-2 max-md:flex-1 max-md:justify-end transition-opacity duration-300${controlsHidden ? " pointer-events-none opacity-0" : controlsDimmed ? " opacity-40" : ""}`}
      >
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
