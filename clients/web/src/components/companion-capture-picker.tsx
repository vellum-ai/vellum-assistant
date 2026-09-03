import { AppWindow, Monitor } from "lucide-react";
import type { CSSProperties, ReactNode, Ref } from "react";

import { companionLayoutFor } from "@/components/companion-layout";
import { useTranslation } from "@/i18n";
import { COMPANION_BASE_AVATAR_BOX } from "@vellumai/ipc-contract";
import type {
  CompanionCapturePick,
  CompanionCaptureSources,
  CompanionCardGrowth,
} from "@vellumai/ipc-contract";

/**
 * The picker Teach opens: what a session could read, as a list to press.
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

/**
 * The most of the card the host's reservation will show, in the units the
 * layout is stated in.
 *
 * The canvas reserves `COMPANION_BASE_CARD_HEIGHT` on the card side of the
 * creature, and the step off the bar takes some of it. What is left is the
 * list's, and a desktop with more on it scrolls inside that rather than
 * growing the card past the edge of a window that never resizes.
 */
const LIST_MAX_HEIGHT = 224;

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
  onPick?: (pick: CompanionCapturePick) => void;
}

export function CompanionCapturePicker({
  sources,
  cardGrowth = "up",
  avatarBox = COMPANION_BASE_AVATAR_BOX,
  optionsBox = COMPANION_BASE_AVATAR_BOX,
  cardRef,
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
      aria-label={t("companionSurface.capturePicker")}
      data-companion-capture-picker
      className="absolute flex flex-col rounded-2xl border border-white/10 bg-[#17181b]/95 py-1.5 shadow-lg shadow-black/40"
      style={{ width: CARD_WIDTH, ...anchor }}
      // A press on a row is a pick, not a grab of the surface.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <div
        className="flex flex-col overflow-y-auto px-1.5"
        style={{ maxHeight: LIST_MAX_HEIGHT }}
      >
        {sources !== null && sources.displays.length > 0 && (
          <Section title={t("companionSurface.captureScreens")}>
            {sources.displays.map((display) => (
              <Row
                key={`display-${display.displayId}`}
                icon={<Monitor className="size-4 shrink-0 text-white/70" />}
                title={t("companionSurface.captureScreen", {
                  n: display.index + 1,
                })}
                onClick={() => {
                  onPick?.({ kind: "display", displayId: display.displayId });
                }}
              />
            ))}
          </Section>
        )}
        {sources !== null && sources.tabs.length > 0 && (
          <Section title={t("companionSurface.captureTabs")}>
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
          <Section title={t("companionSurface.captureWindows")}>
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
          <span className="px-2 py-2 text-[12px] text-white/50">
            {t("companionSurface.captureNothing")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One kind of thing to read, named once above its rows. A heading rather
 * than a divider because a tab row and a Chrome window row are otherwise the
 * same icon and nearly the same words.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="px-2 pt-2 pb-1 text-[10px] tracking-wide text-white/40 uppercase select-none">
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
      className="flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-[12px] text-white/85 transition-colors hover:bg-white/15"
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
  if (icon === undefined) {
    return <AppWindow className="size-4 shrink-0 text-white/70" />;
  }
  return (
    <img src={icon} alt="" className="size-4 shrink-0" draggable={false} />
  );
}
