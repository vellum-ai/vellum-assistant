import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { haptic } from "@/utils/haptics.js";
import { routes } from "@/utils/routes.js";
import { MOBILE_MEDIA_QUERY, useIsMobile } from "@/hooks/use-is-mobile.js";

import { ChatLayoutHeader } from "./chat-layout-header.js";
import { SideMenu } from "./side-menu.js";

/**
 * LocalStorage key used to persist the collapsed state of the sidebar rail
 * across reloads.
 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "assistantSidebarCollapsed";

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
      window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
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

export type SideMenuVariant = "rail" | "overlay";

export interface SideMenuRenderArgs {
  collapsed: boolean;
  variant: SideMenuVariant;
  onClose?: () => void;
  onSearch?: () => void;
}

/**
 * Chat-specific layout route providing sidebar rail, mobile drawer, keyboard
 * shortcuts (Ctrl+\, Ctrl+K, Ctrl+[/]), and the chat header bar. Renders
 * inside RootLayout and wraps chat child routes via `<Outlet />`.
 *
 * References:
 * - React Router nested layouts: https://reactrouter.com/start/data/routing
 */
export function ChatLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  // --- History tracking for back/forward nav ---
  const historyIndexRef = useRef(0);
  const maxHistoryIndexRef = useRef(0);

  const prevLocationRef = useRef(location);
  if (prevLocationRef.current !== location) {
    historyIndexRef.current = window.history.state?.idx ?? 0;
    maxHistoryIndexRef.current = Math.max(
      maxHistoryIndexRef.current,
      historyIndexRef.current,
    );
    prevLocationRef.current = location;
  }

  const canGoBack = historyIndexRef.current > 0;
  const canGoForward = historyIndexRef.current < maxHistoryIndexRef.current;

  const handleStartNewConversation = useCallback(() => {
    navigate(routes.assistant);
  }, [navigate]);

  const handleOpenHome = useCallback(() => {
    navigate(routes.home);
  }, [navigate]);

  const handleGoBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleGoForward = useCallback(() => {
    navigate(1);
  }, [navigate]);

  const isHomeActive = location.pathname === "/home";

  // --- Sidebar collapsed / drawer state ---
  const [collapsed, setCollapsed] = useState<boolean>(readPersistedCollapsed);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        String(collapsed),
      );
    } catch {
      // Storage unavailable (private mode, quota, etc.)
    }
  }, [collapsed]);

  const isMobile = useIsMobile();
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

  // Ctrl/Cmd+K shortcut for command palette — listener is only installed
  // when a handler exists to avoid swallowing the browser's default behavior.

  // Ctrl/Cmd+[ and Ctrl/Cmd+] shortcuts for back/forward navigation
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleShortcut(event, document.activeElement, ["[", "]"])) {
        return;
      }
      event.preventDefault();
      if (event.key === "[") {
        handleGoBack();
      } else if (event.key === "]") {
        handleGoForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleGoBack, handleGoForward]);

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

  const renderSideMenu = useCallback(
    (args: SideMenuRenderArgs): ReactNode => <SideMenu {...args} />,
    [],
  );

  return (
    <>
      <ChatLayoutHeader
        isMobile={isMobile}
        drawerOpen={drawerOpen}
        collapsed={collapsed}
        toggleSidebar={toggleSidebar}
        onStartNewConversation={handleStartNewConversation}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onOpenHome={handleOpenHome}
        isHomeActive={isHomeActive}
      />

      {isMobile ? (
        <main className="relative flex min-w-0 flex-1 min-h-0 overflow-y-auto">
          <Outlet />
          {drawerVisible ? (
            <div
              ref={drawerRef}
              className="fixed inset-0"
              style={{ zIndex: 40 }}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
            >
              <aside
                id="chat-side-menu"
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
                {renderSideMenu({
                  collapsed: false,
                  variant: "overlay",
                  onClose: () => setDrawerOpen(false),
                })}
              </aside>
            </div>
          ) : null}
        </main>
      ) : (
        <div className="flex min-w-0 flex-1 gap-4 p-4 min-h-0 overflow-hidden">
          <aside
            id="chat-side-menu"
            className="shrink-0"
            aria-label="Navigation"
          >
            {renderSideMenu({ collapsed, variant: "rail" })}
          </aside>
          <main
            className="min-w-0 flex-1 overflow-y-auto"
            style={{ flex: 1 }}
          >
            <Outlet />
          </main>
        </div>
      )}
    </>
  );
}
