/**
 * The "Photo or Live?" explainer: what the camera's two capture modes do, drawn
 * over the running preview the first time the viewfinder comes up.
 *
 * An explainer, not a mode picker. Every way out leaves the camera in Photo,
 * which is where the viewfinder already sits; the one action that changes
 * anything is "Try Live", and it is offered rather than asked for. The cards
 * themselves are static, so the only things a press can land on are the two
 * buttons and whatever way out the presentation carries.
 *
 * Presentational. The caller decides when this appears, persists that it was
 * seen, and acts on the dismissal it is handed, so nothing here reads a store
 * or knows anything about the room.
 *
 * A bottom sheet under a thumb and a centred modal under a pointer, forked on
 * the design library's touch-surface signal alone (`docs/PLATFORM_ADAPTATION.md`
 * allows exactly that one signal for a sheet-versus-modal pair). The content is
 * the same in both; what differs is the metrics and where the privacy line and
 * the buttons sit.
 *
 * It renders inside an element the room owns rather than beside the room, which
 * is how `camera-view-settings.tsx` next door solves the same two problems: on
 * iOS and Android only the room's own subtree is visible while the native
 * preview is up, and on the mobile sheet everything else under
 * `#viewport-overlays` is marked inert.
 *
 * Over the feed it takes the camera's fixed palette rather than theme tokens,
 * for the reason `camera-mode-paint.ts` gives.
 *
 * The scrim and the panel are laid out against the host rather than the
 * viewport, which is what scopes the dim to the room: the whole screen on a
 * phone, the content pane on a desktop. The primitives position themselves
 * `fixed`, so both are handed `absolute`, and both opt back into pointer
 * events, since the host lets presses through to the chrome behind it.
 */

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Lock } from "lucide-react";
import { useReducedMotion } from "motion/react";

import {
  BottomSheet,
  Button,
  Modal,
  PortalContainerProvider,
  cn,
  useTouchSurface,
} from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import {
  CAMERA_PILL_LIVE_CLASS,
  CAMERA_SHEET_CARD_CLASS,
  CAMERA_SHEET_CARD_LIVE_CLASS,
  CAMERA_SHEET_INK,
  CAMERA_SHEET_INK_MUTED,
  CAMERA_SHEET_SCRIM_CLASS,
  CAMERA_SHEET_SURFACE,
  CAMERA_SHEET_THUMB_GRADIENT,
  cameraModeStyle,
} from "./camera-mode-paint";

/**
 * How the explainer was left. `gotIt` and `tryLive` are the two buttons;
 * `scrim` is a press on the backdrop; `close` is the modal's own glyph, which
 * only the pointer presentation carries; `escape` is the key.
 *
 * There is no `swipe`: the sheet's grabber is decorative and the default
 * variant exposes no drag dismissal, so nothing would ever report it.
 */
export type CameraExplainerDismissal =
  | "gotIt"
  | "tryLive"
  | "scrim"
  | "close"
  | "escape";

export interface CameraExplainerProps {
  open: boolean;
  /**
   * The room-owned element the sheet or modal portals into, and the box both
   * are laid out against: a positioned element filling the room, which passes
   * presses through to the chrome behind it. Null until the room has committed
   * it, which no press can beat.
   */
  host: HTMLElement | null;
  /** The assistant's display name, already fallen back by the caller. */
  assistantName: string;
  /** Whether "Try Live" is offered at all: false hides the secondary action. */
  tryLiveOffered: boolean;
  /** Every way out, named, so the caller can persist the seen flag and act on "tryLive". */
  onDismiss: (how: CameraExplainerDismissal) => void;
}

/**
 * The scrim, scoped to the host. `absolute` replaces the primitive's `fixed`
 * through tailwind-merge's position group, so `inset-0` resolves against the
 * host rather than the window.
 */
const SCRIM_CLASS = cn(
  "absolute pointer-events-auto",
  CAMERA_SHEET_SCRIM_CLASS,
);

/** The dark sheet, plus the `--camera-*` contract the LIVE tag's fill reads. */
const SHEET_SURFACE_STYLE: CSSProperties = {
  ...cameraModeStyle(),
  backgroundColor: CAMERA_SHEET_SURFACE,
};

/**
 * The same, for the modal, which also carries the library's close glyph. That
 * glyph paints in the two content tokens, and over a surface that never varies
 * by theme a theme ink is as likely to vanish as to read, so the tokens are
 * rebound to the sheet's own pair for the subtree.
 */
const MODAL_SURFACE_STYLE = {
  ...SHEET_SURFACE_STYLE,
  "--content-secondary": CAMERA_SHEET_INK_MUTED,
  "--content-default": CAMERA_SHEET_INK,
} as CSSProperties;

/** The primary action: the ink as a fill, with the surface as its label. */
const PRIMARY_STYLE = {
  "--vbtn-accent": CAMERA_SHEET_INK,
  "--vbtn-accent-fg": CAMERA_SHEET_SURFACE,
} as CSSProperties;

/** The secondary on a phone: words alone, no fill to compete with the primary. */
const SECONDARY_SHEET_STYLE = {
  "--vbtn-accent": "transparent",
  "--vbtn-accent-fg": "rgba(244,241,236,.5)",
} as CSSProperties;

/** The secondary on a pointer, where it sits beside the primary and needs an edge. */
const SECONDARY_MODAL_STYLE = {
  "--vbtn-accent": "rgba(255,255,255,.07)",
  "--vbtn-accent-fg": "rgba(244,241,236,.7)",
} as CSSProperties;

export function CameraExplainer({
  open,
  host,
  assistantName,
  tryLiveOffered,
  onDismiss,
}: CameraExplainerProps): ReactNode {
  const sheet = useTouchSurface();
  const reduce = useReducedMotion();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // One report per opening. Escape reaches this component through up to three
  // listeners, and a press that dismisses must not be counted twice.
  const reported = useRef(false);
  useEffect(() => {
    if (open) {
      reported.current = false;
    }
  }, [open]);
  const report = useCallback(
    (how: CameraExplainerDismissal) => {
      if (reported.current) {
        return;
      }
      reported.current = true;
      onDismiss(how);
    },
    [onDismiss],
  );

  // The modal's built-in close and its backdrop both arrive as
  // `onOpenChange(false)`. The close glyph is the only dismissing control
  // inside the content, so a press that landed there names itself; the flag is
  // cleared on the microtask after the press so a later backdrop tap reads
  // false.
  const pressedInside = useRef(false);
  const markInside = useCallback(() => {
    pressedInside.current = true;
    queueMicrotask(() => {
      pressedInside.current = false;
    });
  }, []);

  const focusTitle = useCallback((event: Event) => {
    // Radix would otherwise land on the first tabbable, which is a button. The
    // title is what says where the user is.
    event.preventDefault();
    titleRef.current?.focus();
  }, []);

  const escape = useCallback(
    (event: { preventDefault: () => void }) => {
      event.preventDefault();
      report("escape");
    },
    [report],
  );

  // Belt to `onEscapeKeyDown`: Radix delivers Escape from a document-level
  // listener that some DOM environments never fire. `report` collapses the two.
  const escapeKeyBelt = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") {
        return;
      }
      event.stopPropagation();
      escape(event);
    },
    [escape],
  );

  if (!host) {
    return null;
  }

  const body = (
    <ExplainerBody
      sheet={sheet}
      assistantName={assistantName}
      tryLiveOffered={tryLiveOffered}
      titleRef={titleRef}
      onAction={report}
    />
  );

  return (
    <PortalContainerProvider container={host}>
      {sheet ? (
        <BottomSheet.Root
          open={open}
          modal
          onOpenChange={(next) => {
            if (!next) {
              report("scrim");
            }
          }}
        >
          <BottomSheet.Content
            data-testid="camera-explainer"
            padded={false}
            overlayClassName={SCRIM_CLASS}
            style={SHEET_SURFACE_STYLE}
            className={cn(
              // `absolute` against the host, keeping the primitive's own
              // `inset-x-0 bottom-0`, so the sheet rides the room's bottom
              // edge rather than the window's.
              "absolute pointer-events-auto",
              "max-h-[85dvh] min-h-0 overflow-y-auto rounded-t-[28px] border-t-0 shadow-none",
              reduce &&
                "data-[state=open]:animate-[fadeIn_var(--anim-snappy)_ease-out]",
            )}
            onEscapeKeyDown={escape}
            onKeyDown={escapeKeyBelt}
            onOpenAutoFocus={focusTitle}
            // The room's sheet starts its minimize drag from a React
            // `pointerdown` that only exempts text controls, so a press in here
            // must not reach it.
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="flex flex-col px-5 pt-3 pb-[calc(30px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]">
              <BottomSheet.Grabber className="mb-[22px] h-[5px] w-[38px] bg-white/22" />
              {body}
            </div>
          </BottomSheet.Content>
        </BottomSheet.Root>
      ) : (
        <Modal.Root
          open={open}
          onOpenChange={(next) => {
            if (!next) {
              report(pressedInside.current ? "close" : "scrim");
            }
          }}
        >
          <Modal.Content
            data-testid="camera-explainer"
            size="md"
            overlayClassName={SCRIM_CLASS}
            style={MODAL_SURFACE_STYLE}
            // The dialog is centred by the overlay it sits inside and is
            // `relative` itself, so the overlay is the only element whose
            // position changes; this one takes the pointer-events opt-in alone.
            className="pointer-events-auto max-w-[640px] rounded-[28px] border-0 p-0 shadow-[0_30px_80px_rgba(0,0,0,.6)]"
            onEscapeKeyDown={escape}
            onKeyDown={escapeKeyBelt}
            onOpenAutoFocus={focusTitle}
            onClickCapture={markInside}
          >
            <div className="flex flex-col px-[34px] pt-[34px] pb-[30px]">
              {body}
            </div>
          </Modal.Content>
        </Modal.Root>
      )}
    </PortalContainerProvider>
  );
}

interface ExplainerBodyProps {
  sheet: boolean;
  assistantName: string;
  tryLiveOffered: boolean;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onAction: (how: CameraExplainerDismissal) => void;
}

/**
 * Everything between the grabber and the bottom edge, in the order both
 * presentations read it: what this is, the two modes side by side, what happens
 * to what the camera sees, and the way out.
 *
 * The title and subtitle come from whichever primitive is hosting them, because
 * Radix names a dialog from its own `Title`.
 */
function ExplainerBody({
  sheet,
  assistantName,
  tryLiveOffered,
  titleRef,
  onAction,
}: ExplainerBodyProps): ReactNode {
  const { t } = useTranslation("chat");

  // The serif brand face at the design's size. The scale's title sizes are the
  // sans ones the app's own headings take, so the size is a rebinding of the
  // token rather than a literal beside it, the way `camera-status-pill.tsx`
  // rebinds the label scale.
  const titleProps = {
    ref: titleRef,
    tabIndex: -1,
    style: { fontFamily: "var(--font-serif)", color: CAMERA_SHEET_INK },
    className: cn(
      "leading-[1.15] outline-none [&>span]:whitespace-normal",
      sheet
        ? "text-title-small [--text-title-small-size:26px]"
        : "text-title-medium [--text-title-medium-size:32px]",
    ),
  };
  const descriptionProps = {
    style: { color: CAMERA_SHEET_INK_MUTED },
    className: cn(
      "mt-0 whitespace-normal",
      sheet
        ? "mb-5 text-body-small-lighter"
        : "mb-[26px] text-body-medium-lighter",
    ),
  };
  const subtitle = t("cameraExplainer.subtitle", { name: assistantName });

  const privacy = (
    <>
      <Lock
        aria-hidden
        className={cn("shrink-0", sheet ? "size-4" : "size-[15px]")}
        style={{ color: CAMERA_SHEET_INK_MUTED }}
      />
      <span
        className="min-w-0 text-body-small-lighter"
        style={{ color: CAMERA_SHEET_INK_MUTED }}
      >
        {t("cameraExplainer.privacy", { name: assistantName })}
      </span>
    </>
  );

  const gotIt = (
    <Button
      variant="accent"
      size="large"
      style={PRIMARY_STYLE}
      className={cn(
        "h-auto font-bold",
        sheet
          ? "w-full rounded-[18px] py-4"
          : "shrink-0 rounded-[14px] px-6 py-[13px]",
      )}
      onClick={() => onAction("gotIt")}
    >
      {t("cameraExplainer.gotIt")}
    </Button>
  );

  const tryLive = tryLiveOffered ? (
    <Button
      variant="accent"
      style={sheet ? SECONDARY_SHEET_STYLE : SECONDARY_MODAL_STYLE}
      className={cn(
        "h-auto font-semibold",
        sheet
          ? // The 44pt target the design's 12px of padding does not reach on
            // its own.
            "min-h-11 w-full rounded-[14px] py-3 text-body-medium-default"
          : "shrink-0 rounded-[14px] px-5 py-[13px] text-body-medium-default",
      )}
      onClick={() => onAction("tryLive")}
    >
      {t(sheet ? "cameraExplainer.tryLive" : "cameraExplainer.tryLiveDesktop")}
    </Button>
  ) : null;

  return (
    <>
      {sheet ? (
        <>
          <BottomSheet.Title {...titleProps}>
            {t("cameraExplainer.title")}
          </BottomSheet.Title>
          <BottomSheet.Description {...descriptionProps}>
            {subtitle}
          </BottomSheet.Description>
        </>
      ) : (
        <>
          <Modal.Title {...titleProps}>
            {t("cameraExplainer.title")}
          </Modal.Title>
          <Modal.Description {...descriptionProps}>
            {subtitle}
          </Modal.Description>
        </>
      )}

      <div
        className={cn(
          "grid grid-cols-2",
          sheet ? "mb-[22px] gap-2.5" : "mb-6 gap-3.5",
        )}
      >
        <ModeCard
          sheet={sheet}
          className={CAMERA_SHEET_CARD_CLASS}
          thumbnail={<PhotoThumbnail sheet={sheet} />}
          label={t("cameraExplainer.photoTitle")}
          body={t("cameraExplainer.photoBody", { name: assistantName })}
        />
        <ModeCard
          sheet={sheet}
          className={CAMERA_SHEET_CARD_LIVE_CLASS}
          thumbnail={<LiveThumbnail sheet={sheet} />}
          label={t("cameraExplainer.liveTitle")}
          body={t(
            sheet
              ? "cameraExplainer.liveBody"
              : "cameraExplainer.liveBodyDesktop",
            { name: assistantName },
          )}
        />
      </div>

      {sheet ? (
        <>
          <div className="mb-[18px] flex items-center gap-2.5 rounded-[14px] bg-white/5 px-3.5 py-3">
            {privacy}
          </div>
          {gotIt}
          {tryLive ? <div className="mt-1.5">{tryLive}</div> : null}
        </>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2.5">{privacy}</div>
          <div className="flex shrink-0 gap-2.5">
            {tryLive}
            {gotIt}
          </div>
        </div>
      )}
    </>
  );
}

interface ModeCardProps {
  sheet: boolean;
  className: string;
  thumbnail: ReactNode;
  label: string;
  body: string;
}

/** One mode: its illustration, its name, and what it does. Static, not a button. */
function ModeCard({
  sheet,
  className,
  thumbnail,
  label,
  body,
}: ModeCardProps): ReactNode {
  return (
    <div
      className={cn(
        "flex flex-col",
        sheet
          ? "gap-3 rounded-[20px] px-3.5 pt-4 pb-3.5"
          : "gap-3.5 rounded-[22px] p-[18px]",
        className,
      )}
    >
      {thumbnail}
      <div>
        <div
          className={cn(
            "font-bold",
            sheet
              ? "mb-[3px] text-label-medium-default [--text-label-medium-default-size:15px]"
              : "mb-1 text-label-medium-default [--text-label-medium-default-size:17px]",
          )}
          style={{ color: CAMERA_SHEET_INK }}
        >
          {label}
        </div>
        <div
          className={
            sheet ? "text-body-small-lighter" : "text-body-medium-lighter"
          }
          style={{ color: CAMERA_SHEET_INK_MUTED }}
        >
          {body}
        </div>
      </div>
    </div>
  );
}

/** The block both illustrations are drawn on. */
function ThumbnailFrame({
  sheet,
  children,
}: {
  sheet: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      aria-hidden
      className={cn(
        "relative overflow-hidden",
        sheet ? "h-[78px] rounded-[12px]" : "h-[120px] rounded-[14px]",
      )}
      style={{ background: CAMERA_SHEET_THUMB_GRADIENT }}
    >
      {children}
    </div>
  );
}

/** Photo: one frame, and the shutter dot under it. */
function PhotoThumbnail({ sheet }: { sheet: boolean }): ReactNode {
  return (
    <ThumbnailFrame sheet={sheet}>
      <div
        className={cn(
          "absolute border-white",
          sheet
            ? "inset-x-[22px] inset-y-[10px] rounded-[6px] border-2"
            : "inset-x-[60px] inset-y-4 rounded-[8px] border-[2.5px]",
        )}
      />
      <div
        className={cn(
          "absolute left-1/2 -translate-x-1/2 rounded-full bg-white",
          sheet ? "bottom-2 size-4" : "bottom-3 size-[22px]",
        )}
      />
    </ThumbnailFrame>
  );
}

/** Live: a stack of frames going back, and the tag that says it is streaming. */
function LiveThumbnail({ sheet }: { sheet: boolean }): ReactNode {
  const { t } = useTranslation("chat");
  const frame = sheet
    ? "absolute top-3 h-11 w-[34px] rounded-[5px]"
    : "absolute top-[22px] h-[72px] w-[60px] rounded-[7px]";

  return (
    <ThumbnailFrame sheet={sheet}>
      <div
        className={cn(
          frame,
          "border-white/35",
          sheet ? "left-2 border-[1.5px]" : "left-6 border-2",
        )}
      />
      <div
        className={cn(
          frame,
          "border-white/55 bg-[rgba(75,72,68,.8)]",
          sheet ? "left-[30px] border-[1.5px]" : "left-[66px] border-2",
        )}
      />
      <div
        className={cn(
          frame,
          "border-white bg-[#4b4844]",
          sheet ? "left-[52px] border-2" : "left-[108px] border-[2.5px]",
        )}
      />
      <span
        className={cn(
          "absolute inline-flex items-center rounded-full",
          CAMERA_PILL_LIVE_CLASS,
          sheet
            ? "top-2 right-2 gap-1 px-1.5 py-0.5"
            : "top-3 right-3 gap-1.5 px-[9px] py-[3px]",
        )}
      >
        {/* `bg-current` rather than white: the fill publishes whichever ink
            reads on the assistant's accent, and white is what it publishes for
            the camera's own crimson. */}
        <span
          className={cn(
            "rounded-full bg-current",
            sheet ? "size-[5px]" : "size-1.5",
          )}
        />
        <span
          className={cn(
            "text-label-small-default font-bold uppercase tracking-[.06em]",
            // The scale's smallest label is the desktop size; the phone tag
            // rebinds it rather than writing a literal beside it.
            sheet && "[--text-label-small-default-size:8px]",
          )}
        >
          {t("cameraExplainer.liveTag")}
        </span>
      </span>
    </ThumbnailFrame>
  );
}
