import { Button } from "@vellumai/design-library";
import {
  ChevronLeft,
  ChevronRight,
  Menu as MenuIcon,
  PanelLeft,
  Search,
} from "lucide-react";
import { useCallback, useEffect, type ReactNode } from "react";

import { WindowsMenuBar } from "@/components/windows-menu-bar";
import { NATIVE_MOBILE_BARE_ICON_BUTTON } from "@/domains/chat/utils/native-mobile-button-constants";
import { WINDOWS_TITLE_BAR_CONTROL_CLEARANCE_PX } from "@/runtime/electron-window-chrome";
import {
  detectElectronHostOS,
  isNativeMobile,
} from "@/runtime/platform-detection";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import {
  resolveShellBackground,
  usePageSurfaceStore,
} from "@/stores/page-surface-store";
import { useTitleBarStore } from "@/stores/title-bar-store";
import { useTranslation } from "@/i18n";

// On macOS the native window controls (traffic lights) overlay the top-left of
// the renderer. In the Electron shell the header renders as a unified title bar
// sitting *inline* with those controls (the desktop app centres the cluster
// vertically via `MAIN_TRAFFIC_LIGHT_POSITION`), so the left icon row is inset
// to start clear of the ~71px-wide cluster with a comfortable gap after it.
// The header's own `px-4` supplies the first 16px; this adds the remainder
// (≈ button left edge at 96px, leaving a ~25px gap past the green control).
// Off Electron the inset is 0.
const ELECTRON_TRAFFIC_LIGHT_CLEARANCE = 80;

/**
 * The `data-slot` this header publishes, and the selector that finds it.
 *
 * Surfaces portalled out of the chat layout position themselves against this
 * header's bottom edge and have to locate it from outside the tree. They read
 * these rather than writing the attribute name again, so the published name
 * has one owner: the component that publishes it.
 */
export const CHAT_LAYOUT_HEADER_SLOT = "chat-layout-header";
export const CHAT_LAYOUT_HEADER_SELECTOR = `[data-slot="${CHAT_LAYOUT_HEADER_SLOT}"]`;

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
  /**
   * Leads the right cluster, ahead of the mobile search button. The
   * voice-session pill sits here so a live session reads as the leftmost
   * thing in the cluster rather than buried between search and the
   * notification bell.
   */
  topBarRightLeading?: ReactNode;
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
  topBarRightLeading,
  topBarRightSlot,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: ChatLayoutHeaderProps) {
  const toggleCommandPalette = useCommandPaletteStore.use.toggle();
  const handleSearchClick = useCallback(() => {
    toggleCommandPalette();
  }, [toggleCommandPalette]);

  // In the Electron shell the header doubles as the macOS title bar: it sits
  // inline with the traffic lights and drives window dragging
  // (`-webkit-app-region: drag`), with its interactive children opting back
  // out via `no-drag`. While mounted it claims the title bar so the global
  // `WindowDragRegion` fallback strip yields (see `useTitleBarStore`) —
  // otherwise that strip, living outside `.app-shell`'s `isolation: isolate`
  // context, would out-stack and swallow clicks on the header's buttons.
  // Gated to Electron so the web/iOS layouts are byte-for-byte unchanged.
  const { t } = useTranslation("chat");
  const electronHostOS = detectElectronHostOS();
  const electron = electronHostOS !== null;

  // Mobile-only: on desktop the same affordance lives in the left cluster.
  const searchButton = isMobile ? (
    <Button
      variant="ghost"
      iconOnly={<Search />}
      aria-label={t("chatLayoutHeader.searchAria")}
      tooltip={t("chatLayoutHeader.searchAria")}
      className={NATIVE_MOBILE_BARE_ICON_BUTTON}
      onClick={handleSearchClick}
    />
  ) : null;

  const setInlineTitleBarActive =
    useTitleBarStore.use.setInlineTitleBarActive();
  useEffect(() => {
    if (!electron) {
      return;
    }
    setInlineTitleBarActive(true);
    return () => setInlineTitleBarActive(false);
  }, [electron, setInlineTitleBarActive]);

  // The header sits between the safe-area strips and the page content, both of
  // which take the route's published surface on the native shells. Painting it
  // from the same resolver is what makes the color continuous instead of a
  // neutral band across the top. Off native mobile, and on any route that
  // publishes nothing, this resolves to the usual neutral chrome.
  const pageSurface = usePageSurfaceStore.use.surface();
  const headerBackground = resolveShellBackground(
    pageSurface,
    isNativeMobile(),
  );

  return (
    <header
      data-slot={CHAT_LAYOUT_HEADER_SLOT}
      className={`flex w-full shrink-0 items-center gap-4 px-4 pt-4${isMobile && !electron ? " pb-4" : ""}${
        electron
          ? " select-none [-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag]"
          : ""
      }`}
      style={{
        background: headerBackground,
        minHeight: electron ? "44px" : "40px",
        paddingTop: electron ? 0 : undefined,
        paddingRight:
          electronHostOS === "windows"
            ? WINDOWS_TITLE_BAR_CONTROL_CLEARANCE_PX
            : undefined,
      }}
    >
      <div
        // `inert` (not just opacity/pointer-events) so the faded-out
        // controls also leave the tab order and accessibility tree.
        inert={controlsHidden || undefined}
        className={`flex items-center gap-2 transition-[min-width,opacity] duration-300 ease-in-out max-md:shrink-0${controlsHidden ? " pointer-events-none opacity-0" : controlsDimmed ? " opacity-40" : ""}`}
        style={{
          // `minWidth` reserves the sidebar column on desktop only. The Electron
          // inset clears the inline traffic lights regardless of `isMobile` —
          // they stay put even in the narrow mobile layout.
          ...(isMobile
            ? {}
            : { minWidth: collapsed ? 48 : (sidebarWidth ?? 230) }),
          ...(electronHostOS === "macos"
            ? { paddingLeft: ELECTRON_TRAFFIC_LIGHT_CLEARANCE }
            : {}),
        }}
      >
        {isMobile ? (
          <Button
            variant="ghost"
            iconOnly={<MenuIcon />}
            aria-label={t("chatLayoutHeader.openNavigationAria")}
            aria-expanded={drawerOpen}
            aria-controls="chat-side-menu"
            tooltip={t("chatLayoutHeader.openNavigationAria")}
            onClick={toggleSidebar}
          />
        ) : (
          <Button
            variant="ghost"
            iconOnly={<PanelLeft />}
            aria-label={t("chatLayoutHeader.toggleSidebarAria")}
            aria-expanded={!collapsed}
            aria-controls="chat-side-menu"
            tooltip={t("chatLayoutHeader.toggleSidebarAria")}
            onClick={toggleSidebar}
          />
        )}
        {!isMobile ? (
          <>
            <Button
              variant="ghost"
              iconOnly={<Search />}
              aria-label={t("chatLayoutHeader.searchAria")}
              tooltip={t("chatLayoutHeader.searchAria")}
              onClick={handleSearchClick}
            />
            <Button
              variant="ghost"
              iconOnly={<ChevronLeft />}
              aria-label={t("chatLayoutHeader.backAria")}
              tooltip={t("chatLayoutHeader.backAria")}
              disabled={!canGoBack}
              className={!canGoBack ? "opacity-35" : undefined}
              onClick={onGoBack}
            />
            <Button
              variant="ghost"
              iconOnly={<ChevronRight />}
              aria-label={t("chatLayoutHeader.forwardAria")}
              tooltip={t("chatLayoutHeader.forwardAria")}
              disabled={!canGoForward}
              className={!canGoForward ? "opacity-35" : undefined}
              onClick={onGoForward}
            />
          </>
        ) : null}
        {/* Outside the isMobile branch: while this header is mounted the
            fallback strip yields, so a narrow (zoomed) Windows window would
            otherwise lose the menus entirely. Self-gates to the Windows
            shell (renders nothing elsewhere), so no `electronHostOS`
            branch here. */}
        <WindowsMenuBar />
      </div>

      <div
        inert={controlsHidden || centerHidden || undefined}
        // Left-aligned on mobile, pulled in 12px past the header's own
        // `gap-4` (16px) to sit closer to the menu button, 4px total.
        // Desktop keeps the title centered in the remaining space.
        className={`flex min-w-0 flex-1 items-center max-md:-ml-3 max-md:justify-start justify-center transition-opacity duration-300${controlsHidden || centerHidden ? " pointer-events-none opacity-0" : ""}`}
      >
        {topBarCenter}
      </div>

      {/* `shrink-0`, not `flex-1`: these are fixed-size controls, and a wide
          occupant (the voice-session pill) would otherwise either squash them
          into each other or hold the row at its intrinsic width and push the
          trailing ones off-screen. The centre slot is the only zone that
          gives. */}
      <div
        inert={controlsHidden || undefined}
        className={`flex shrink-0 items-center gap-2 max-md:justify-end transition-opacity duration-300${controlsHidden ? " pointer-events-none opacity-0" : controlsDimmed ? " opacity-40" : ""}`}
      >
        {topBarRightLeading}
        {searchButton}
        {topBarRightSlot}
      </div>
    </header>
  );
}
