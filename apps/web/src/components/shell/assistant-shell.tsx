import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { haptic } from "@/utils/haptics.js";
import { MOBILE_MEDIA_QUERY, useIsMobile } from "@/hooks/use-is-mobile.js";
import { useVisibleViewport } from "@/hooks/use-visible-viewport.js";

import { AssistantShellHeader } from "./assistant-shell-header.js";

/**
 * Threshold (in px) below which a `innerHeight − visualViewport.height` delta
 * is treated as the soft keyboard opening. Below this we assume incidental
 * drift from browser chrome / pinch-zoom and leave the layout alone.
 */
const KEYBOARD_OPEN_THRESHOLD_PX = 100;

/**
 * LocalStorage key used to persist the collapsed state of the sidebar rail
 * across reloads.
 */
export const ASSISTANT_SIDEBAR_COLLAPSED_STORAGE_KEY =
  "assistantSidebarCollapsed";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function readPersistedCollapsed(): boolean {
  try {
    return (
      window.localStorage.getItem(ASSISTANT_SIDEBAR_COLLAPSED_STORAGE_KEY) ===
      "true"
    );
  } catch {
    return false;
  }
}

export function shouldCloseDrawerOnViewportChange(isMobile: boolean): boolean {
  return !isMobile;
}

/**
 * Returns `true` when the keyboard event matches Ctrl/Cmd + one of the given
 * keys and the active element is not an input surface.
 */
export function shouldHandleShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">,
  activeElement: Element | null,
  key: string | string[],
): boolean {
  const modifierPressed = event.metaKey || event.ctrlKey;
  if (!modifierPressed) {
    return false;
  }
  const keys = Array.isArray(key) ? key : [key];
  if (!keys.includes(event.key)) {
    return false;
  }
  if (!activeElement) {
    return true;
  }
  const tag = activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return false;
  }
  if (activeElement.getAttribute("contenteditable") === "true") {
    return false;
  }
  return true;
}

export type AssistantShellSideMenuVariant = "rail" | "overlay";

export interface AssistantShellSideMenuArgs {
  collapsed: boolean;
  variant: AssistantShellSideMenuVariant;
  onClose?: () => void;
  onSearch?: () => void;
}

export interface AssistantShellProps {
  /**
   * Render-prop for the side menu content. Receives whether the rail is
   * collapsed and which variant to render (`"rail"` on desktop, `"overlay"`
   * on mobile).
   */
  sideMenu: (args: AssistantShellSideMenuArgs) => ReactNode;
  topBarRightSlot?: ReactNode;
  topBarCenter?: ReactNode;
  onStartNewConversation?: () => void;
  onToggleCommandPalette?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onOpenHome?: () => void;
  isHomeActive?: boolean;
  children: ReactNode;
  /**
   * Overlay nodes that must remain anchored to the visual viewport — not
   * to the shell's chat-content coordinate space. Rendered outside the inner
   * wrapper that carries the iOS visual-viewport `translate3d`.
   */
  viewportOverlays?: ReactNode;
}

export function AssistantShell({
  sideMenu,
  topBarRightSlot,
  topBarCenter,
  onStartNewConversation,
  onToggleCommandPalette,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onOpenHome,
  isHomeActive,
  children,
  viewportOverlays,
}: AssistantShellProps) {
  const [collapsed, setCollapsed] = useState<boolean>(readPersistedCollapsed);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ASSISTANT_SIDEBAR_COLLAPSED_STORAGE_KEY,
        String(collapsed),
      );
    } catch {
      // Storage unavailable (private mode, quota, etc.)
    }
  }, [collapsed]);

  const isMobile = useIsMobile();
  const visibleViewport = useVisibleViewport();
  const keyboardOpen =
    isMobile &&
    visibleViewport !== null &&
    visibleViewport.keyboardHeight > KEYBOARD_OPEN_THRESHOLD_PX;
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

  useEffect(() => {
    if (shouldCloseDrawerOnViewportChange(isMobile)) {
      setDrawerOpen(false);
    }
  }, [isMobile]);

  const drawerVisible = isMobile && drawerOpen;

  const toggleSidebar = useCallback(() => {
    haptic.light();
    if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) {
      setDrawerOpen((value) => !value);
    } else {
      setCollapsed((value) => !value);
    }
  }, []);

  // Ctrl/Cmd+\ shortcut to toggle sidebar
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, "\\")) {
        return;
      }
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [toggleSidebar]);

  // Ctrl/Cmd+K shortcut for command palette
  useEffect(() => {
    if (!onToggleCommandPalette) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, "k")) {
        return;
      }
      event.preventDefault();
      onToggleCommandPalette();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onToggleCommandPalette]);

  // Ctrl/Cmd+[ and Ctrl/Cmd+] shortcuts for back/forward navigation
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, ["[", "]"])) {
        return;
      }
      event.preventDefault();
      if (event.key === "[" && onGoBack) {
        onGoBack();
      } else if (event.key === "]" && onGoForward) {
        onGoForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onGoBack, onGoForward]);

  // Mobile drawer — focus trap, ESC to close, body-scroll-lock
  const drawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!drawerVisible) {
      return;
    }

    drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        drawerRef.current &&
        !drawerRef.current.contains(document.activeElement)
      ) {
        return;
      }

      if (event.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) {
        return;
      }
      const focusable =
        drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const isInDrawer = drawerRef.current.contains(active);

      if (event.shiftKey) {
        if (!isInDrawer || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!isInDrawer || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [drawerVisible]);

  // iOS visual-viewport keyboard tracking
  const followVisualViewport =
    keyboardOpen &&
    visibleViewport !== null &&
    (visibleViewport.offsetTop !== 0 || visibleViewport.offsetLeft !== 0);
  const shellTransform = followVisualViewport
    ? `translate3d(${visibleViewport.offsetLeft}px, ${visibleViewport.offsetTop}px, 0)`
    : undefined;

  return (
    <div
      className="app-shell"
      style={{
        background: "var(--surface-base)",
        height:
          keyboardOpen && visibleViewport
            ? `${visibleViewport.height}px`
            : "100dvh",
        paddingBottom: keyboardOpen
          ? "0px"
          : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
        paddingLeft:
          "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
        paddingRight:
          "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
        isolation: "isolate",
      }}
    >
      <div
        className="flex min-w-0 flex-col overflow-hidden h-full w-full"
        style={{
          transform: shellTransform,
          transformOrigin: shellTransform ? "0 0" : undefined,
        }}
      >
        <AssistantShellHeader
          isMobile={isMobile}
          drawerOpen={drawerOpen}
          collapsed={collapsed}
          toggleSidebar={toggleSidebar}
          topBarCenter={topBarCenter}
          topBarRightSlot={topBarRightSlot}
          onStartNewConversation={onStartNewConversation}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={onGoBack}
          onGoForward={onGoForward}
          onSearchClick={onToggleCommandPalette}
          onOpenHome={onOpenHome}
          isHomeActive={isHomeActive}
        />

        {isMobile ? (
          <main className="relative flex min-w-0 flex-1 min-h-0 overflow-y-auto">
            {children}
            {drawerVisible ? (
              <div
                ref={drawerRef}
                className="fixed inset-0"
                style={{ zIndex: 40 }}
                role="dialog"
                aria-modal="true"
                aria-label="Assistant navigation"
              >
                <aside
                  id="assistant-side-menu"
                  className="relative flex h-full w-full flex-col shadow-xl"
                  style={{
                    background: "var(--surface-lift)",
                    borderRight: "1px solid var(--border-base)",
                    zIndex: 50,
                    paddingTop:
                      "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
                    paddingBottom:
                      "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
                    paddingLeft:
                      "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
                  }}
                >
                  {sideMenu({
                    collapsed: false,
                    variant: "overlay",
                    onClose: () => setDrawerOpen(false),
                    onSearch: onToggleCommandPalette,
                  })}
                </aside>
              </div>
            ) : null}
          </main>
        ) : (
          <div className="flex min-w-0 flex-1 gap-4 p-4 min-h-0 overflow-hidden">
            <aside
              id="assistant-side-menu"
              className="shrink-0"
              aria-label="Assistant navigation"
            >
              {sideMenu({ collapsed, variant: "rail" })}
            </aside>
            <main
              className="min-w-0 flex-1 overflow-y-auto"
              style={{ flex: 1 }}
            >
              {children}
            </main>
          </div>
        )}
      </div>
      {viewportOverlays}
    </div>
  );
}
