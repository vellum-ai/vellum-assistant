import { AppWindow, Monitor } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { companionLayoutFor } from "@/components/companion-layout";
import { useTranslation } from "@/i18n";
import { ScrollShadow } from "@vellumai/design-library/components/scroll-shadow";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
import { COMPANION_BASE_AVATAR_BOX } from "@vellumai/ipc-contract";
import type {
  CompanionCapturePick,
  CompanionCaptureSources,
  CompanionCardGrowth,
  WatchCaptureTarget,
} from "@vellumai/ipc-contract";

/**
 * The picker Teach and Share open: what a session could read, or be shown, as
 * a grid of what those things currently look like.
 *
 * A card beside the call bar rather than a row on it. The bar is one thin row
 * by design and a desktop has a dozen windows on it, so the choice is drawn
 * where the introduction's card is drawn, on the height the host reserves for
 * a card, and scrolls inside that when the desktop has more than fits.
 *
 * **One kind at a time, and each thing shown as itself.** A person picking a
 * window is looking for the one they were just in, and a title is a poor
 * likeness of it: half the windows on a desktop are called after the app that
 * owns them, and the rest after a file. So each row is a tile with a picture
 * of the thing in it, taken when the card opened, and the kinds are separated
 * onto a segmented control rather than run together down one list, since
 * "which screen" and "which window" are different questions and a person has
 * only one of them at a time.
 *
 * A Chrome tab is a row rather than a tile. A tab has no window of its own
 * until Chrome has been told to show it, so the only way to draw a picture of
 * one is to switch the user's browser to it while they are still deciding.
 * The host resolves a picked tab to the window showing it, so the surface
 * never has to know a tab is not a window.
 *
 * **It offers and holds nothing** but the pictures. The list is the host's
 * answer at the moment the card opened, and a press leaves this renderer as a
 * pick. What comes back, once the window that owns the session has one to
 * report, is `watching` and the target the session actually reads.
 */

/**
 * The card's width, fixed rather than measured, for the reason the
 * introduction's is: a grid of pictures has no natural width, and a card that
 * changed shape with what happened to be on the desktop would move under the
 * hand between one open and the next.
 *
 * Three tiles across at a size a window is still recognisable at. The canvas
 * holds it: main sizes the canvas for the call bar's own reach either side of
 * the creature, which is wider than this at every size the surface is drawn
 * at.
 */
const CARD_WIDTH = 460;

/** How many tiles stand across the card. */
const GRID_COLUMNS = 3;

/**
 * The height of a tile's picture.
 *
 * The picture is fitted inside it rather than cropped to it, so a tall window
 * and a wide display are both shown whole and the rows stay one height. Sized
 * so that two rows and the segmented control above them fit the height the
 * host reserves for a card, with the third row under the fold as the hint
 * that there is more.
 */
const THUMBNAIL_HEIGHT = 88;

/** How many tiles the loading state stands in for. */
const SKELETON_TILES = 3;

/** The three questions the segmented control switches between. */
type CaptureKind = "screens" | "tabs" | "windows";

const KIND_ORDER: CaptureKind[] = ["screens", "tabs", "windows"];

/** How many of a kind the host listed. */
const countOf = (
  sources: CompanionCaptureSources,
  kind: CaptureKind,
): number =>
  kind === "screens"
    ? sources.displays.length
    : kind === "tabs"
      ? sources.tabs.length
      : sources.windows.length;

/**
 * The kind the card opens on: the screens when there are any, since that is
 * the whole-desktop answer and the one a person who has not thought about it
 * yet means. Falls through to whatever the desktop does have.
 */
const openingKind = (sources: CompanionCaptureSources): CaptureKind =>
  KIND_ORDER.find((kind) => countOf(sources, kind) > 0) ?? "screens";

/** A target as the key its picture is held under. */
const keyOf = (target: WatchCaptureTarget): string =>
  target.kind === "display"
    ? `display-${target.displayId}`
    : `window-${target.windowId}`;

export interface CompanionCapturePickerProps {
  /**
   * What the host listed, or `null` while it is still being asked. The card
   * is drawn either way, so the press that opened it is seen to have opened
   * something before the list lands.
   */
  sources: CompanionCaptureSources | null;
  /**
   * A picture of one display or window, or nothing where the host could take
   * none. Absent off the shell, where the tiles are drawn from their icons
   * alone; the card never waits on it, so the grid is pressable from the
   * moment it is drawn.
   */
  captureThumbnail?: (target: WatchCaptureTarget) => Promise<string | null>;
  cardGrowth?: CompanionCardGrowth;
  avatarBox?: number;
  optionsBox?: number;
  /**
   * The card's own element, for the host to hit-test the pointer against. The
   * companion's window is click-through except where it is told otherwise, and
   * every tile here is a press.
   */
  cardRef?: Ref<HTMLDivElement>;
  /**
   * What the card is choosing for, as a reader hears it: what to teach from,
   * or what to share. The tiles are the same either way; only the question
   * differs.
   */
  label?: string;
  onPick?: (pick: CompanionCapturePick) => void;
}

export function CompanionCapturePicker({
  sources,
  captureThumbnail,
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

  const kinds =
    sources === null
      ? []
      : KIND_ORDER.filter((kind) => countOf(sources, kind) > 0);
  const empty = sources !== null && kinds.length === 0;

  // The user's answer, and null until they give one. Derived rather than
  // seeded, because the card is drawn before the host has answered: a state
  // initialised from an empty list would hold the wrong kind for as long as
  // the card is open. A chosen kind that is not on offer falls back the same
  // way, which is what a list arriving without it means.
  const [chosen, setChosen] = useState<CaptureKind | null>(null);
  const kind =
    sources === null
      ? "screens"
      : chosen !== null && kinds.includes(chosen)
        ? chosen
        : openingKind(sources);

  const targets = useMemo((): { key: string; target: WatchCaptureTarget }[] => {
    if (sources === null) {
      return [];
    }
    if (kind === "screens") {
      return sources.displays.map((display) => {
        const target: WatchCaptureTarget = {
          kind: "display",
          displayId: display.displayId,
        };
        return { key: keyOf(target), target };
      });
    }
    if (kind === "windows") {
      return sources.windows.map((window) => {
        const target: WatchCaptureTarget = {
          kind: "window",
          windowId: window.windowId,
        };
        return { key: keyOf(target), target };
      });
    }
    // A tab is not a window yet, so there is nothing to take a picture of.
    return [];
  }, [kind, sources]);

  /**
   * What the host has answered, per tile. A key with no entry has not been
   * answered yet and its tile is drawn as waiting; a key answered with null is
   * one the host could take no picture of, and its tile settles for the icon
   * rather than waiting forever. Both answers are held in the one map so a
   * tile's state is a single lookup rather than a lookup and a guess.
   */
  const [thumbnails, setThumbnails] = useState<
    ReadonlyMap<string, string | null>
  >(new Map());
  /** Keys already asked for, so switching kinds and back does not ask twice. */
  const asked = useRef(new Set<string>());
  /**
   * Which list the asking belongs to. A capture is a round trip through the
   * window server, and a list that arrived while one was in flight describes a
   * desktop the picture is no longer of: window ids are the window server's to
   * hand out again, so a late picture written under a key the new list also
   * holds would be a tile showing something the user never had open.
   */
  const listing = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A new list is a new desktop: whatever was asked for, and whatever kind the
  // user had narrowed to, belonged to the card they have already left. Teach
  // pressed over Share's open picker is a new question in the same card, and
  // it opens the way the first one did. Declared above the asking effect so it
  // runs first when both fire on the same list.
  useEffect(() => {
    asked.current = new Set();
    listing.current += 1;
    setThumbnails(new Map());
    setChosen(null);
  }, [sources]);

  // The grid is scrolled per card, not per kind: a switch is a different list
  // in the same box, and the rows above whatever the last kind was scrolled to
  // would start out of sight.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (listRef.current !== null) {
      listRef.current.scrollTop = 0;
    }
  }, [kind]);

  useEffect(() => {
    if (captureThumbnail === undefined) {
      return;
    }
    for (const { key, target } of targets) {
      if (asked.current.has(key)) {
        continue;
      }
      asked.current.add(key);
      const of = listing.current;
      // A null is recorded rather than dropped, and nothing is said about it:
      // a window that closed while the card was opening is the desktop's
      // answer, not a fault. The tile keeps its icon and stays pressable,
      // since the pick may still resolve to something. A host that refuses
      // outright is read the same way, which is what keeps a rejection from
      // reaching the renderer as an unhandled one.
      const land = (thumbnail: string | null): void => {
        if (!mounted.current || of !== listing.current) {
          return;
        }
        setThumbnails((prev) => new Map(prev).set(key, thumbnail));
      };
      void captureThumbnail(target).then(land, () => {
        land(null);
      });
    }
  }, [captureThumbnail, targets]);

  // A shell that cannot take pictures has already answered every tile: there
  // is nothing coming, so the ground settles on the icon rather than waiting
  // on a request that was never made.
  const answerFor = (key: string): string | null | undefined =>
    captureThumbnail === undefined ? null : thumbnails.get(key);

  /** What a kind is called, as the segment naming it reads. */
  const nameOf = (of: CaptureKind): string =>
    t(
      of === "screens"
        ? "companionSurface.captureScreens"
        : of === "tabs"
          ? "companionSurface.captureTabs"
          : "companionSurface.captureWindows",
    );

  return (
    <div
      ref={cardRef}
      // A group rather than a listbox or a dialog: it takes no focus and traps
      // none, since the window it is in is unfocusable and every press here is
      // the pointer's.
      role="group"
      aria-label={label ?? t("companionSurface.capturePicker")}
      data-companion-capture-picker
      // The card is dark whatever the app's theme is, and it is drawn in a
      // window with no theme on its root, so the scope is declared here: the
      // design library's tokens are written to be read off a non-root
      // ancestor, and a control taking them from `:root` would draw its light
      // palette on this card.
      data-theme="dark"
      className="absolute flex flex-col rounded-2xl border border-white/10 bg-[#17181b]/95 p-1.5 shadow-lg shadow-black/40"
      style={{ width: CARD_WIDTH, ...anchor }}
      // A press on a tile is a pick, not a grab of the surface.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {/*
       * Which question the grid below is answering. Drawn only when the
       * desktop offers more than one kind: a control with a single segment on
       * it is a label pretending to be a choice.
       */}
      {kinds.length > 1 && (
        <SegmentControl
          // As wide as its segments rather than the card: the control names
          // the kinds, and a bar stretched across a card of tiles reads as a
          // header rather than a choice.
          className="mx-auto mb-1.5 w-auto shrink-0"
          items={kinds.map((each) => ({ value: each, label: nameOf(each) }))}
          value={kind}
          ariaLabel={t("companionSurface.captureKind")}
          onChange={setChosen}
        />
      )}
      {/*
       * `ScrollShadow` fades the bottom edge only while content is actually
       * hidden past it, from the real scroll position rather than a content-
       * height guess, so the hint disappears once the user scrolls to the
       * last row. It also hides the scrollbar the same way the surface hides
       * every other one: a bottom fade already carries the "there is more"
       * hint a visible thumb would duplicate.
       */}
      {/*
       * `max-h-48` (192px) is the most of the card the host's reservation will
       * show once the segmented control has taken its row: the canvas reserves
       * `COMPANION_BASE_CARD_HEIGHT` on the card side of the creature and the
       * step off the bar takes some of it. What is left is the grid's, and a
       * desktop with more on it scrolls inside that rather than growing the
       * card past the edge of a window that never resizes.
       */}
      <ScrollShadow
        ref={listRef}
        className="max-h-48 flex-col px-0.5"
        size={24}
        fadeEdges="end"
        hideScrollBar
      >
        <div className="flex flex-col" data-slot="capture-sources">
          {sources === null && <SkeletonGrid />}
          {sources !== null && kind === "screens" && (
            <Grid>
              {sources.displays.map((display) => {
                const name = t("companionSurface.captureScreen", {
                  n: display.index + 1,
                });
                const key = keyOf({
                  kind: "display",
                  displayId: display.displayId,
                });
                return (
                  <Tile
                    key={key}
                    title={name}
                    ariaLabel={name}
                    answer={answerFor(key)}
                    fallback={
                      <Monitor className="size-5 text-white/40" aria-hidden />
                    }
                    onClick={() => {
                      onPick?.({
                        kind: "display",
                        displayId: display.displayId,
                      });
                    }}
                  />
                );
              })}
            </Grid>
          )}
          {sources !== null && kind === "windows" && (
            <Grid>
              {sources.windows.map((window) => {
                const key = keyOf({
                  kind: "window",
                  windowId: window.windowId,
                });
                // The app's name stands in for a window that has none of its
                // own, which is common enough (a palette, a player) that a tile
                // reading as blank would be one nobody could pick on purpose.
                const name = window.title === "" ? window.app : window.title;
                return (
                  <Tile
                    key={key}
                    title={name}
                    // The tile's whole text is its name: a reader is told the
                    // window and the app it belongs to in one breath, the way a
                    // looking user reads both.
                    ariaLabel={
                      window.title === "" ? name : `${name} (${window.app})`
                    }
                    answer={answerFor(key)}
                    fallback={<SourceIcon icon={window.icon} large />}
                    icon={<SourceIcon icon={window.icon} />}
                    onClick={() => {
                      onPick?.({ kind: "window", windowId: window.windowId });
                    }}
                  />
                );
              })}
            </Grid>
          )}
          {sources !== null && kind === "tabs" && (
            <div className="flex flex-col">
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
            </div>
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

/** The tiles, however many of them there are, in fixed columns. */
function Grid({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid gap-1.5 py-0.5"
      style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  );
}

/**
 * One thing to read, drawn as itself.
 *
 * The picture is fitted rather than cropped: a tall window cropped to a wide
 * tile is a picture of its middle, which is where windows keep the least of
 * what identifies them.
 */
function Tile({
  title,
  ariaLabel,
  answer,
  fallback,
  icon,
  onClick,
}: {
  title: string;
  ariaLabel: string;
  /**
   * What the host answered for this tile: a picture, null where it could take
   * none, and undefined while it has not answered yet. Undefined draws the
   * ground as waiting; null settles it on the icon rather than waiting
   * forever.
   */
  answer?: string | null;
  /** What stands in the picture's place: the app's icon, or a glyph. */
  fallback: ReactNode;
  /** The owning app, named beside the title, for a tile that has one. */
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-slot="capture-source"
      className="group flex min-w-0 flex-col gap-1 rounded-lg p-1 text-left transition-colors outline-none hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-white/40 focus-visible:ring-inset active:bg-white/15"
      onClick={onClick}
    >
      <span
        data-slot="capture-preview"
        className={`flex items-center justify-center overflow-hidden rounded-md bg-black/40 ring-1 ring-white/10 ${
          answer === undefined ? "animate-pulse" : ""
        }`}
        style={{ height: THUMBNAIL_HEIGHT }}
      >
        {answer === undefined || answer === null ? (
          fallback
        ) : (
          <img
            src={answer}
            alt=""
            draggable={false}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1">
        {icon}
        <span className="min-w-0 flex-1 truncate text-[11px] text-white/75 group-hover:text-white/90">
          {title}
        </span>
      </span>
    </button>
  );
}

/**
 * One Chrome tab, as a row: there is no picture of a tab that is not the one
 * in front, and the title is how a person knows a page anyway.
 */
function Row({
  icon,
  title,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      data-slot="capture-source"
      className="flex h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 text-left text-[12px] text-white/85 transition-colors outline-none hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-white/40 focus-visible:ring-inset active:bg-white/15"
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </button>
  );
}

/** The owning app's icon, or a window glyph where the host could read none. */
function SourceIcon({
  icon,
  large = false,
}: {
  icon?: string;
  large?: boolean;
}) {
  const box = large ? "size-7 rounded-lg" : "size-3.5 rounded-[4px]";
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-white/10 ${box}`}
    >
      {icon === undefined ? (
        <AppWindow
          className={large ? "size-5 text-white/40" : "size-3 text-white/70"}
          aria-hidden
        />
      ) : (
        <img src={icon} alt="" className="size-full" draggable={false} />
      )}
    </span>
  );
}

/**
 * Tiles that stand in for the grid before the host has answered, in the shape
 * the answer draws: one row of the same tiles, since a desktop has at least
 * one screen on it and usually more windows than fit.
 *
 * Shaped like the eventual tiles rather than a spinner or a sentence, so the
 * card does not change size or layout once the list actually lands.
 */
function SkeletonGrid() {
  return (
    <Grid>
      {Array.from({ length: SKELETON_TILES }, (_, index) => (
        <div key={index} className="flex flex-col gap-1 p-1" aria-hidden>
          <span
            className="animate-pulse rounded-md bg-white/10"
            style={{ height: THUMBNAIL_HEIGHT }}
          />
          <span
            className="h-2 animate-pulse rounded-full bg-white/10"
            style={{ width: index === 0 ? "70%" : "45%" }}
          />
        </div>
      ))}
    </Grid>
  );
}
