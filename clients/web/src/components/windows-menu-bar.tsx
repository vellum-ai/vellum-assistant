import { Button } from "@vellumai/design-library";
import { useEffect, useState } from "react";

import { getMenuBarTitles, popupMenuBarMenu } from "@/runtime/menu";

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
 * Self-gating: renders nothing until the shell reports its menu titles.
 * Off Electron, on macOS (whose menu bar the system draws), and on shells
 * that predate the popup bridge, the titles query resolves empty and the
 * bar stays unmounted.
 */
export function WindowsMenuBar() {
  const [titles, setTitles] = useState<string[]>([]);
  const [openTitle, setOpenTitle] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMenuBarTitles().then((fetched) => {
      if (!cancelled) {
        setTitles(fetched);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (titles.length === 0) {
    return null;
  }

  const openMenu = (title: string, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    setOpenTitle(title);
    void popupMenuBarMenu(
      title,
      Math.round(rect.left),
      Math.round(rect.bottom),
    ).finally(() => {
      // The popup call resolves when the native menu closes; only the menu
      // that is still marked open clears the highlight, so a click that
      // opened another title meanwhile keeps its own state.
      setOpenTitle((current) => (current === title ? null : current));
    });
  };

  return (
    <div role="menubar" className="flex items-center">
      {titles.map((title) => (
        <Button
          key={title}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={openTitle === title}
          variant="ghost"
          size="compact"
          active={openTitle === title}
          className="[--vbtn-fg:var(--content-secondary)]"
          onClick={(event) => {
            openMenu(title, event.currentTarget);
          }}
        >
          {title}
        </Button>
      ))}
    </div>
  );
}
