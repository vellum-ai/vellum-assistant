import { Button } from "@vellumai/design-library";
import { useEffect, useState } from "react";

import { useTranslation } from "@/i18n";
import {
  getMenuBarEntries,
  popupMenuBarMenu,
  type MenuBarEntry,
} from "@/runtime/menu";
import { useTitleBarStore } from "@/stores/title-bar-store";

// Edit and Window carry only stock role items (undo/copy/minimize...) whose
// shortcuts everyone knows; hiding them keeps the bar short. Their items stay
// reachable through the (hidden) application menu's accelerators.
const HIDDEN_MENU_IDS = new Set(["edit", "window"]);

/**
 * In-title-bar menu bar for the Windows desktop shell.
 *
 * The Windows main window hides the native frame (`titleBarStyle: "hidden"`),
 * which hides the OS menu bar with it. This draws the top-level menu titles
 * as flat buttons in the renderer's title bar; clicking one asks the main
 * process to pop the real native submenu just below the button, so items,
 * accelerators, and enabled states stay owned by the shell's one menu
 * template (`clients/windows/src/main/menu.ts`).
 *
 * Mounted in both title-bar surfaces: `ChatLayoutHeader` (the inline title
 * bar on chat routes) and `WindowDragRegion` (the fallback strip everywhere
 * else), so the menus survive navigation to routes without the chat layout.
 * Full-screen shells with their own chrome (settings) suppress it through
 * the title-bar store.
 *
 * Self-gating: renders nothing until the shell reports its menus. Off
 * Electron, on macOS (whose menu bar the system draws), and on shells that
 * predate the popup bridge, the query resolves empty and the bar stays
 * unmounted.
 */
export function WindowsMenuBar() {
  const { t } = useTranslation();
  const suppressed = useTitleBarStore.use.windowsMenuBarSuppressed();
  const [entries, setEntries] = useState<MenuBarEntry[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMenuBarEntries().then((fetched) => {
      if (!cancelled) {
        setEntries(fetched.filter((entry) => !HIDDEN_MENU_IDS.has(entry.id)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (suppressed || entries.length === 0) {
    return null;
  }

  // The shell reports stable menu ids; the visible label comes from the
  // catalog. An id the catalog doesn't know yet (a newer shell) falls back
  // to the shell's own label rather than disappearing.
  const labels: Record<string, string | undefined> = {
    file: t("windowsMenuBar.file"),
    view: t("windowsMenuBar.view"),
    developer: t("windowsMenuBar.developer"),
    help: t("windowsMenuBar.help"),
  };

  const openMenu = (id: string, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    setOpenId(id);
    void popupMenuBarMenu(
      id,
      Math.round(rect.left),
      Math.round(rect.bottom),
    ).finally(() => {
      // The popup call resolves when the native menu closes; only the menu
      // that is still marked open clears the highlight, so a click that
      // opened another menu meanwhile keeps its own state.
      setOpenId((current) => (current === id ? null : current));
    });
  };

  return (
    <div role="menubar" className="flex items-center">
      {entries.map((entry) => (
        <Button
          key={entry.id}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={openId === entry.id}
          variant="ghost"
          active={openId === entry.id}
          // Regular size for the text scale of the neighboring header
          // buttons, slimmed to menu-bar proportions. The labels recede
          // into the chrome: quiet in light, disabled-ramp in dark/velvet
          // (a shade dimmer than quiet resolves there). no-drag: both
          // mounts sit inside a window-drag surface.
          className="h-6 px-2 [--vbtn-fg:var(--content-quiet)] dark:[--vbtn-fg:var(--content-disabled)] [-webkit-app-region:no-drag]"
          onClick={(event) => {
            openMenu(entry.id, event.currentTarget);
          }}
        >
          {labels[entry.id] ?? entry.label}
        </Button>
      ))}
    </div>
  );
}
