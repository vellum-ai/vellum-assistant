import {
  Button,
  Typography,
  formatAcceleratorHint,
} from "@vellumai/design-library";
import type { LucideIcon } from "lucide-react";
import { Loader2, Search, X } from "lucide-react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type FC,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { CommandPaletteItem } from "@/components/command-palette/command-palette-item";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { useIsNativeMobile } from "@/runtime/platform-detection";
import { usePointerCoarse } from "@/utils/pointer";

// z-50 keeps the full-screen palette above the navigation drawer (fixed z-40
// in chat-layout), which stays mounted underneath so dismissing search returns
// to the menu.
const MOBILE_SHEET_CLASSES =
  "fixed inset-0 z-50 flex flex-col bg-[var(--surface-lift)]";

const MOBILE_SHEET_SAFE_AREA_STYLE: CSSProperties = {
  paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
  paddingBottom:
    "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
  paddingLeft: "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
  paddingRight: "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
};

// The exiting sheet still covers the viewport, so taps aimed at the chat and
// the drawer underneath have to pass through it.
const MOBILE_SHEET_EXITING_STYLE: CSSProperties = {
  ...MOBILE_SHEET_SAFE_AREA_STYLE,
  pointerEvents: "none",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandPaletteItemData {
  id: string;
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  /** Longer match excerpt rendered as a second line under the title. */
  snippet?: string;
  shortcutHint?: ReactNode;
}

export interface CommandPaletteSection {
  id: string;
  label: string;
  items: CommandPaletteItemData[];
}

export interface CommandPaletteProps {
  /** Whether the palette is currently visible. */
  isOpen: boolean;
  /** Close the palette. */
  onClose: () => void;
  /** Current search query. */
  query: string;
  /** Update the search query. */
  onQueryChange: (value: string) => void;
  /**
   * Lexical tokens of the term the server matched on, used to highlight
   * matches inside result snippets.
   */
  highlightTokens?: string[];
  /** Currently selected index (flat across all sections). */
  selectedIndex: number;
  /** Sections of results to display. */
  sections: CommandPaletteSection[];
  /** Whether a server search is currently in-flight. */
  isSearching?: boolean;
  /** Called when an item is selected (clicked or Enter pressed). */
  onItemSelect?: (item: CommandPaletteItemData, index: number) => void;
  /** Key-down handler from useCommandPalette for keyboard navigation. */
  onKeyDown: (e: KeyboardEvent) => void;
  /** Render without the main-app backdrop/portal inside a floating window. */
  surface?: "overlay" | "window";
}

interface MobileSheetProps {
  /** Key-down handler from useCommandPalette for keyboard navigation. */
  onKeyDown: (e: KeyboardEvent) => void;
  children: ReactNode;
}

/**
 * Full-screen sheet used by native mobile shells, sliding up on open and out on
 * close. It outlives `isOpen` for the length of the exit, and AnimatePresence
 * renders the exiting element with the props it was frozen at, so everything
 * that has to change the moment the exit starts reads `useIsPresent()`
 * instead: the sheet stops taking taps, drops out of the accessibility tree,
 * and releases focus.
 */
const MobileSheet: FC<MobileSheetProps> = ({ onKeyDown, children }) => {
  const { t } = useTranslation();
  const isPresent = useIsPresent();
  const reduceMotion = useReducedMotion();
  const sheetRef = useRef<HTMLDivElement>(null);

  // Blurring the search input starts native keyboard dismissal in parallel
  // with the slide-out. Scoped to the sheet so focus that a close handler
  // moved elsewhere (the composer, after "New Conversation") survives.
  useLayoutEffect(() => {
    if (isPresent) {
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && sheetRef.current?.contains(active)) {
      active.blur();
    }
  }, [isPresent]);

  return (
    <motion.div
      ref={sheetRef}
      className={MOBILE_SHEET_CLASSES}
      style={
        isPresent ? MOBILE_SHEET_SAFE_AREA_STYLE : MOBILE_SHEET_EXITING_STYLE
      }
      role="dialog"
      aria-modal={isPresent ? true : undefined}
      aria-hidden={isPresent ? undefined : true}
      aria-label={t("commandPalette.searchAriaLabel")}
      onKeyDown={onKeyDown}
      initial={{ y: "100%", opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: "100%", opacity: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }
      }
    >
      {children}
    </motion.div>
  );
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * macOS Spotlight-style command palette overlay on desktop, swapping to a
 * full-area inline overlay on mobile (`max-width: 767px`). Dismissable by
 * Escape or backdrop click.
 *
 * Two independent questions, two signals. How much room there is decides the
 * container (`useIsMobile()`); whether a chord can be pressed at all decides
 * the keyboard hints, per-item and the ⌘K cap (`usePointerCoarse()`). They come
 * apart on shipped hardware in both directions: a tablet is roomy with no ⌘
 * key, and a desktop window narrowed past the breakpoint still has the whole
 * keyboard. See `docs/PLATFORM_ADAPTATION.md`, and `docs/CAPACITOR.md`
 * § Keyboard-only affordances for why the pointer is the signal for the second.
 *
 * Accepts items/sections as props — no data fetching is performed internally.
 */
export const CommandPalette: FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  query,
  onQueryChange,
  highlightTokens,
  selectedIndex,
  sections,
  isSearching = false,
  onItemSelect,
  onKeyDown,
  surface = "overlay",
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const isNativeMobileShell = useIsNativeMobile();
  // Subscribed rather than read once: the palette outlives any one pointer, so
  // a convertible whose keyboard comes off has to stop advertising ⌘K without
  // a reload, and a tablet docked into one has to start.
  const pointerCoarse = usePointerCoarse();
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus the search input when the palette opens.
  useEffect(() => {
    if (isOpen) {
      // Small timeout to ensure the element is mounted before focusing.
      const id = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  // Scroll the selected item into view when keyboard-navigating.
  useEffect(() => {
    if (!isOpen || !listRef.current) {
      return;
    }
    const selected = listRef.current.querySelector("[aria-current='page']");
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, selectedIndex]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === overlayRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  const isWindowSurface = surface === "window";
  const useMobileLayout = isMobile && !isWindowSurface;
  // A soft keyboard offers no ⌘ and no chord, so on a coarse pointer every
  // hint here names a gesture the device cannot make. Width would answer the
  // wrong question: it hides the hints on a narrowed desktop window that can
  // still press all of them, and shows them on a tablet that cannot press any.
  const showKeyboardHints = !pointerCoarse;
  // Native mobile shells keep the sheet mounted while AnimatePresence plays
  // the slide-out exit.
  const animateMobileSheet = isNativeMobileShell && useMobileLayout;

  if (!isOpen && !animateMobileSheet) {
    return null;
  }

  // Flatten all items to compute the global index for each item.
  let flatIndex = 0;

  const searchInputRow = (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] px-4 py-3">
      {isSearching ? (
        <Loader2
          size={16}
          aria-hidden
          className="shrink-0 animate-spin text-[var(--content-tertiary)]"
        />
      ) : (
        <Search
          size={16}
          aria-hidden
          className="shrink-0 text-[var(--content-tertiary)]"
        />
      )}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={t("commandPalette.placeholder")}
        className={
          isWindowSurface
            ? "min-w-0 flex-1 bg-transparent text-sm font-medium text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none"
            : "min-w-0 flex-1 bg-transparent text-body-medium-lighter text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none"
        }
        aria-label={t("commandPalette.searchAriaLabel")}
      />
      {query ? (
        useMobileLayout ? (
          <button
            type="button"
            className="shrink-0 text-body-medium-lighter text-[var(--content-tertiary)]"
            onClick={() => onQueryChange("")}
            aria-label={t("commandPalette.clearSearch")}
          >
            {t("commandPalette.clear")}
          </button>
        ) : isWindowSurface ? (
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-overlay)] hover:text-[var(--content-default)]"
            aria-label={t("commandPalette.clearSearch")}
            onClick={() => onQueryChange("")}
          >
            <X size={16} aria-hidden />
          </button>
        ) : (
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<X />}
            aria-label={t("commandPalette.clearSearch")}
            onClick={() => onQueryChange("")}
            tintColor="var(--content-tertiary)"
          />
        )
      ) : showKeyboardHints ? (
        <kbd
          className={
            isWindowSurface
              ? "shrink-0 rounded-md border border-[var(--border-base)] bg-[var(--surface-active)] px-1.5 py-0.5 text-xs font-medium text-[var(--content-secondary)]"
              : "shrink-0 rounded-md border border-[var(--border-base)] bg-[var(--surface-active)] px-1.5 py-0.5 text-label-small-default text-[var(--content-tertiary)]"
          }
        >
          {formatAcceleratorHint("CmdOrCtrl+K")}
        </kbd>
      ) : null}
      {useMobileLayout ? (
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          expandOnMobile={false}
          aria-label={t("commandPalette.closeSearch")}
          onClick={onClose}
          tintColor="var(--content-tertiary)"
        />
      ) : null}
    </div>
  );

  const resultsList = (
    <div
      ref={listRef}
      className={
        useMobileLayout
          ? "flex-1 overflow-y-auto overscroll-contain p-2"
          : "max-h-[360px] overflow-y-auto overscroll-contain p-2"
      }
      role="listbox"
    >
      {sections.length === 0 ? (
        <div className="px-3 py-6 text-center">
          <Typography
            variant="body-medium-lighter"
            className="text-[var(--content-tertiary)]"
          >
            {isSearching
              ? t("commandPalette.searching")
              : t("commandPalette.noResults")}
          </Typography>
        </div>
      ) : (
        sections.map((section) => (
          <div key={section.id} role="group" aria-label={section.label}>
            <Typography
              variant="label-small-default"
              as="div"
              className={
                isWindowSurface
                  ? "px-3 pb-1 pt-2 text-xs font-semibold text-[var(--content-tertiary)]"
                  : /* Bump the 10px label token to the 12px body-small token
                       on mobile, where it reads too small (Figma 6764:6748). */
                    "px-3 pb-1 pt-2 text-[var(--content-tertiary)] max-md:text-body-small-default"
              }
            >
              {section.label}
            </Typography>
            {section.items.map((item) => {
              const currentIndex = flatIndex++;
              return (
                <CommandPaletteItem
                  key={item.id}
                  icon={item.icon}
                  title={item.title}
                  subtitle={item.subtitle}
                  snippet={item.snippet}
                  highlightTokens={highlightTokens}
                  shortcutHint={
                    showKeyboardHints ? item.shortcutHint : undefined
                  }
                  isSelected={currentIndex === selectedIndex}
                  onClick={() => onItemSelect?.(item, currentIndex)}
                  surface={surface}
                />
              );
            })}
          </div>
        ))
      )}
    </div>
  );

  if (animateMobileSheet) {
    return (
      <AnimatePresence>
        {isOpen ? (
          <MobileSheet key="command-palette-sheet" onKeyDown={onKeyDown}>
            {searchInputRow}
            {resultsList}
          </MobileSheet>
        ) : null}
      </AnimatePresence>
    );
  }

  if (useMobileLayout) {
    return (
      <div
        className={MOBILE_SHEET_CLASSES}
        role="dialog"
        aria-modal="true"
        aria-label={t("commandPalette.searchAriaLabel")}
        onKeyDown={onKeyDown}
        style={MOBILE_SHEET_SAFE_AREA_STYLE}
      >
        {searchInputRow}
        {resultsList}
      </div>
    );
  }

  const desktopPalette = (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("commandPalette.ariaLabel")}
      className={
        surface === "window"
          ? "flex h-full w-full items-start justify-center bg-transparent p-3"
          : "fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      }
      onClick={handleBackdropClick}
      onKeyDown={onKeyDown}
    >
      <div className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] shadow-xl">
        {searchInputRow}
        {resultsList}
      </div>
    </div>
  );

  if (surface === "window") {
    return desktopPalette;
  }

  return createPortal(desktopPalette, document.body);
};
