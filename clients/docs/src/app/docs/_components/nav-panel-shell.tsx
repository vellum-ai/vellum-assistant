"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";

import { DocsSearch } from "@/app/docs/_components/docs-search";
import { DocsThemePicker } from "@/app/docs/_components/docs-theme-picker";
import { DocsGithubLink } from "@/app/docs/_components/docs-github-link";
import { useDocsNav } from "@/app/docs/_components/docs-nav-context";

/**
 * Shared sidebar shell for docs-style navs: a slide-in drawer with overlay,
 * close button, and theme/GitHub footer on mobile, and a sticky sidebar on
 * desktop. Callers provide the scrollable nav list as children.
 */
export function NavPanelShell({ children }: { children: ReactNode }) {
  const { visible, animating, close } = useDocsNav();

  const navContent = (
    <div className="flex h-full flex-col">
      {/* Search only renders here on mobile; desktop has it in the header.
          The header instance owns the global Cmd/Ctrl+K shortcut, so this
          duplicate must not register it too. */}
      <div className="shrink-0 px-4 pt-4 pb-3 md:hidden">
        <DocsSearch registerShortcut={false} />
      </div>
      {children}
    </div>
  );

  return (
    <>
      {/* Mobile drawer */}
      {visible && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className={`docs-nav-overlay absolute inset-0 transition-opacity duration-250 ${
              animating ? "opacity-100" : "opacity-0"
            }`}
            onClick={close}
          />
          <div
            className={`docs-nav-panel absolute inset-y-0 left-0 w-72 overflow-y-auto border-r shadow-xl transition-transform duration-250 ease-out flex flex-col ${
              animating ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            <button
              type="button"
              onClick={close}
              className="docs-nav-close absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg"
              aria-label="Close navigation"
            >
              <X size={18} />
            </button>
            <div className="flex-1 overflow-y-auto">{navContent}</div>
            <div
              className="docs-nav-mobile-footer flex items-center justify-between border-t px-4 py-3"
              style={{ borderColor: "var(--docs-border)" }}
            >
              <DocsThemePicker />
              <DocsGithubLink />
            </div>
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <nav className="docs-nav-panel hidden border-r md:sticky md:top-[101px] md:block md:h-[calc(100vh-101px)] md:w-64 md:shrink-0 md:self-start md:overflow-y-auto md:pb-8">
        {navContent}
      </nav>
    </>
  );
}
