import { AppWindow, Monitor } from "lucide-react";
import { type CSSProperties, type ReactNode, type Ref } from "react";

import { companionLayoutFor } from "@/components/companion-layout";
import { useTranslation } from "@/i18n";
import { ScrollShadow } from "@vellumai/design-library/components/scroll-shadow";
import { COMPANION_BASE_AVATAR_BOX } from "@vellumai/ipc-contract";
import type {
  CompanionCapturePick,
  CompanionCaptureSources,
  CompanionCardGrowth,
} from "@vellumai/ipc-contract";

/**
 * The picker Teach and Share open: what a session could read, or be shown, as
 * a list to press.
 *
 * A card beside the call bar rather than a row on it. The bar is one thin row
 * by design and a desktop has a dozen windows on it, so the choice is drawn
 * where the introduction's card is drawn, on the height the host reserves for
 * a card, and scrolls inside that when the desktop has more than fits.
 *
 * Three sections in the order a person narrows a choice: the screens, then
 * the Chrome tabs, then every other window. A tab is offered as a thing of its
 * own because that is how people think of what is in their browser, and the
 * host resolves a picked tab to the window showing it, so the surface never
 * has to know a tab is not a window.
 *
 * **It offers and holds nothing.** The list is the host's answer at the moment
 * the card opened, and a press leaves this renderer as a pick. What comes
 * back, once the window that owns the session has one to report, is
 * `watching` and the target the session actually reads.
 */

/**
 * The card's width, fixed rather than measured, for the reason the
 * introduction's is: a list of titles has no natural width, and a card that
 * changed shape with what happened to be on the desktop would move under the
 * hand between one open and the next.
 */
const CARD_WIDTH = 260;

/** How many rows the loading state stands in for, in each of its two groups. */
const SKELETON_ROWS = 3;

export interface CompanionCapturePickerProps {
  /**
   * What the host listed, or `null` while it is still being asked. The card
   * is drawn either way, so the press that opened it is seen to have opened
   * something before the list lands.
   */
  sources: CompanionCaptureSources | null;
  cardGrowth?: CompanionCardGrowth;
  avatarBox?: number;
  optionsBox?: number;
  /**
   * The card's own element, for the host to hit-test the pointer against. The
   * companion's window is click-through except where it is told otherwise, and
   * every row here is a press.
   */
  cardRef?: Ref<HTMLDivElement>;
  /**
   * What the card is choosing for, as a reader hears it: what to teach from,
   * or what to share. The rows are the same either way; only the question
   * differs.
   */
  label?: string;
  onPick?: (pick: CompanionCapturePick) => void;
}

export function CompanionCapturePicker({
  sources,
  cardGrowth = "up",
  avatarBox = COMPANION_BASE_AVATAR_BOX,
  optionsBox = COMPANION_BASE_AVATAR_BOX,
  cardRef,
  label,
  onPick,
}: CompanionCapturePickerProps) {
  const { t } = useTranslation();
  const { inUnits, lineAt, introStepOff } = companionLayoutFor(
    avatarBox,
    optionsBox,
  );
  // Clears the call bar and the gap above it, the same step the introduction's
  // card takes off the pill: the bar is centred on the creature's line and is
  // no taller than the pill the step was sized for.
  const stepOff = inUnits(introStepOff(cardGrowth));

  // Centred on the creature's point, which on a call is the bar's centre. The
  // introduction hangs its card off the creature's edge because the pill is
  // beside the creature then; here the bar closes around it, and a card hung
  // off one edge of a centred bar would sit lopsided over it. Teach is only
  // on the call row, so this card is only ever over the bar.
  const anchor: CSSProperties = {
    left: "50%",
    top: lineAt(cardGrowth, 0),
    transform:
      cardGrowth === "up"
        ? `translate(-50%, calc(-100% - ${stepOff}px))`
        : `translate(-50%, ${stepOff}px)`,
  };

  const empty =
    sources !== null &&
    sources.displays.length === 0 &&
    sources.tabs.length === 0 &&
    sources.windows.length === 0;

  return (
    <div
      ref={cardRef}
      // A group rather than a listbox or a dialog: it takes no focus and traps
      // none, since the window it is in is unfocusable and every press here is
      // the pointer's.
      role="group"
      aria-label={label ?? t("companionSurface.capturePicker")}
      data-companion-capture-picker
      className="absolute flex flex-col rounded-2xl border border-white/10 bg-[#17181b]/95 py-1.5 shadow-lg shadow-black/40"
      style={{ width: CARD_WIDTH, ...anchor }}
      // A press on a row is a pick, not a grab of the surface.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {/*
       * `max-h-56` (224px) is the most of the card the host's reservation
       * will show: the canvas reserves `COMPANION_BASE_CARD_HEIGHT` on the
       * card side of the creature, and the step off the bar takes some of
       * it. What is left is the list's, and a desktop with more on it
       * scrolls inside that rather than growing the card past the edge of a
       * window that never resizes.
       *
       * `ScrollShadow` fades the bottom edge only while content is actually
       * hidden past it, from the real scroll position rather than a content-
       * height guess, so the hint disappears once the user scrolls to the
       * last row. It also hides the scrollbar the same way the surface hides
       * every other one: a bottom fade already carries the "there is more"
       * hint a visible thumb would duplicate.
       */}
      <ScrollShadow
        className="max-h-56 flex-col px-1.5"
        size={24}
        fadeEdges="end"
        hideScrollBar
      >
        <div className="flex flex-col">
          {sources === null && <SkeletonList />}
          {sources !== null && sources.displays.length > 0 && (
            <Section title={t("companionSurface.captureScreens")} first>
              {sources.displays.map((display) => (
                <Row
                  key={`display-${display.displayId}`}
                  icon={<Monitor className="size-4 shrink-0 text-white/70" />}
                  title={t("companionSurface.captureScreen", {
                    n: display.index + 1,
                  })}
                  onClick={() => {
                    onPick?.({
                      kind: "display",
                      displayId: display.displayId,
                    });
                  }}
                />
              ))}
            </Section>
          )}
          {sources !== null && sources.tabs.length > 0 && (
            <Section
              title={t("companionSurface.captureTabs")}
              first={sources.displays.length === 0}
            >
              {sources.tabs.map((tab) => (
                <Row
                  key={`tab-${tab.chromeWindowId}-${tab.tabIndex}`}
                  icon={<SourceIcon icon={tab.icon} />}
                  title={tab.title}
                  onClick={() => {
                    onPick?.({
                      kind: "tab",
                      chromeWindowId: tab.chromeWindowId,
                      tabIndex: tab.tabIndex,
                    });
                  }}
                />
              ))}
            </Section>
          )}
          {sources !== null && sources.windows.length > 0 && (
            <Section
              title={t("companionSurface.captureWindows")}
              first={sources.displays.length === 0 && sources.tabs.length === 0}
            >
              {sources.windows.map((window) => (
                <Row
                  key={`window-${window.windowId}`}
                  icon={<SourceIcon icon={window.icon} />}
                  // The app's name stands in for a window that has none of its
                  // own, which is common enough (a palette, a player) that a row
                  // reading as blank would be a row nobody could pick on purpose.
                  title={window.title === "" ? window.app : window.title}
                  detail={window.title === "" ? undefined : window.app}
                  onClick={() => {
                    onPick?.({ kind: "window", windowId: window.windowId });
                  }}
                />
              ))}
            </Section>
          )}
          {empty && (
            <span className="px-2 py-3 text-[12px] text-white/50">
              {t("companionSurface.captureNothing")}
            </span>
          )}
        </div>
      </ScrollShadow>
    </div>
  );
}

/**
 * One kind of thing to read, named once above its rows. A heading rather
 * than a divider because a tab row and a Chrome window row are otherwise the
 * same icon and nearly the same words.
 */
function Section({
  title,
  first = false,
  children,
}: {
  title: string;
  /** Whether this is the first section drawn, which carries no top hairline. */
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col ${first ? "" : "mt-1 border-t border-white/5 pt-1"}`}
    >
      <span className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-white/35 uppercase select-none">
        {title}
      </span>
      {children}
    </div>
  );
}

function Row({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  /** What the title belongs to, when the title alone does not say. */
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      // The row's whole text is its name: a reader is told the window and the
      // app it belongs to in one breath, the way a looking user reads both.
      aria-label={detail === undefined ? title : `${title} (${detail})`}
      className="flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-[12px] text-white/85 transition-colors outline-none hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-white/40 focus-visible:ring-inset active:bg-white/15"
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {detail !== undefined && (
        <span className="max-w-[80px] shrink-0 truncate text-[11px] text-white/40">
          {detail}
        </span>
      )}
    </button>
  );
}

/** The owning app's icon, or a window glyph where the host could read none. */
function SourceIcon({ icon }: { icon?: string }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[5px] ring-1 ring-white/10">
      {icon === undefined ? (
        <AppWindow className="size-3.5 text-white/70" />
      ) : (
        <img src={icon} alt="" className="size-full" draggable={false} />
      )}
    </span>
  );
}

/**
 * Rows that stand in for the list before the host has answered, in the same
 * two-group shape the answer draws: a screen never named this early because
 * displays resolve first and rarely more than one or two deep, then a longer
 * run for whatever else the desktop turns out to hold.
 *
 * Shaped like the eventual rows rather than a spinner or a sentence, so the
 * card does not change size or layout once the list actually lands.
 */
function SkeletonList() {
  return (
    <div className="flex flex-col gap-1 px-0.5 py-1.5" aria-hidden>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <SkeletonRow key={index} wide={index === 0} />
      ))}
    </div>
  );
}

function SkeletonRow({ wide }: { wide: boolean }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-2">
      <span className="size-4 shrink-0 animate-pulse rounded-[5px] bg-white/10" />
      <span
        className="h-2 animate-pulse rounded-full bg-white/10"
        style={{ width: wide ? "70%" : "45%" }}
      />
    </div>
  );
}
