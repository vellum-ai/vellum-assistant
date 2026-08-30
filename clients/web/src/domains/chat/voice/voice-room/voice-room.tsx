import { useTranslation } from "@/i18n";
/**
 * "Voice room" — the owning-composer surface for a live-voice session,
 * mounted by `chat-layout.tsx` as a purely additive overlay: the composer's
 * voice bar and display transcript still render underneath, hidden by this
 * layer, so removing the room leaves the old UI intact.
 *
 * One look, whatever the assistant wears. Every resolved avatar fills the room
 * with a color and draws the same voice bands, the same transcript zones and
 * the same toned chrome ({@link toneForBg}, via the `--room-*` CSS vars); the
 * only thing avatar type decides is what stands in the middle of it:
 *
 * - Character avatars ({@link resolveVoiceRoomLook}) bring their palette color
 *   and their eyes, so entering plays the onboarding Introduction-step grow:
 *   the body springs from its on-screen size to BE the screen, the color fades
 *   in behind it, the giant eyes grow into the center. See
 *   {@link VoiceRoomColorLook}.
 * - Custom-image avatars have no palette color and no eyes, so the room samples
 *   a field color out of the uploaded image ({@link useCustomAvatarFieldHex})
 *   and the image itself takes the center. Everything else is the character
 *   room, which is the point: a session reads the same whichever avatar the
 *   assistant wears.
 * - Until the avatar query settles there is no color to paint with, so the room
 *   holds the deep-dark ambient void and its bands ride the avatar tint (the
 *   dark voice ink would be invisible on it). That is a loading state, not a
 *   look.
 *
 * Two placement variants (see `chat-layout.tsx` for the mounts):
 *
 * - `"content"` (desktop): `absolute inset-0` inside the layout's `<main>`,
 *   an inset panel that leaves the title bar and left sidenav visible AND
 *   interactive, so the user can keep navigating; navigating away hands the
 *   session off to the title-bar pill. Deliberately not `aria-modal`: the
 *   surrounding chrome stays usable.
 * - `"sheet"` (mobile): a `BottomSheet` that slides up and rests below the
 *   thread header, the mobile counterpart of the inset panel. Radix portals it
 *   out of the layout and positions it `fixed`, so it is told where the header
 *   ends ({@link useChatHeaderBottom}) rather than inheriting that edge from
 *   the DOM. Opening the camera takes it to the top of the screen instead, with
 *   square corners: the viewfinder is full-bleed, so the chrome framing it is
 *   too. Non-modal, so the header it rests below stays lit and usable,
 *   which takes suppressing several of Radix's modal reflexes: see
 *   {@link VoiceRoomSheet}. It portals into `RootLayout`'s `#viewport-overlays`
 *   rather than the body, which is what keeps the surfaces the header opens
 *   ON TOP of it: see {@link VoiceRoom}. Because the slide IS its entrance, the
 *   look inside is painted rather than grown. See `voice-room-entrance.ts`.
 * - `"fullscreen"`: `fixed inset-0` over the whole viewport, modal, with
 *   safe-area padding for notched iOS shells. No longer mounted by the chat
 *   layout; kept as the variant a surface with no chrome to sit under would
 *   want, and the default.
 *
 * The look is laid out against the ROOM's box, not the window's. See
 * {@link useRoomBox}. As a panel those are different rectangles, so the look's
 * color field, its giant eyes, and its voice bands are all sized to the
 * panel, and the entry origin (published in viewport space by the composer) is
 * converted to room-local space before the entrance grows from it. The sheet
 * reads no origin: it presents the look rather than growing it.
 *
 * The room is not exit-only. Minimizing (the corner chevron, Escape, or — on
 * the sheet — pulling it down) dismisses the room while the session keeps
 * running, handing the session to the composer's voice bar or the title-bar
 * pill; ending the session (the control row's ✕) tears the whole call down.
 *
 * Visibility is a pure function of {@link useIsVoiceRoomVisible} — active
 * session, owned by the on-screen composer, main window, not minimized. Any
 * session end (user exit, `failed`, conversation timeout, stop from
 * elsewhere) flips that predicate false and unmounts the room; a `failed`
 * session surfaces through the existing composer Notice / pill failure chip,
 * never a dead room.
 *
 * Sessions are hands-free (server-VAD): the user just speaks, so there is no
 * push-to-talk control. One centred row near the bottom carries what a caller
 * does mid-call, left to right: mute the mic so it stops hearing you, mute the
 * assistant so you stop hearing it, show it the camera, and end the session.
 * The end control is a red ✕ — the same glyph the composer bar and the pill
 * end a session with — toned destructively so it never reads as a third
 * neutral toggle beside the two mutes.
 *
 * **The camera is a mode of this room, not a place the user goes.** Opening it
 * swaps the look for a live viewfinder and adds a shutter above the control
 * row; the transcript, the controls and the call are all untouched, and
 * closing it reveals the look again. That is what lets it stay open across a
 * run of photos ("what's this?" … "and this one?"), where the system camera,
 * being modal and one-shot, would charge a full open/aim/expose cycle per
 * question. Each photo lands in the conversation as its own user message the
 * moment it is taken and runs no turn, so shutter-then-speak and
 * speak-then-shutter behave the same and nothing races the sentence in
 * progress. See `voice-camera.ts` for the capture rules (video-only
 * native Capacitor preview with a browser-stream fallback, both video-only so
 * the call's audio is never renegotiated) and
 * `use-voice-room-camera.ts` for the send path, which is the composer's own
 * attachment upload.
 *
 * **Leaving the room and ending the call are different acts, and the room says
 * so in three places.** Minimizing is the light one — the session keeps running
 * on the composer's voice bar or the title-bar pill — and it is what the corner
 * chevron does, what Escape does (every variant; the key handler attaches only
 * while the room is mounted), and what pulling the mobile sheet down does. All
 * three are the same call to `minimizeVoiceRoom`. Ending is the heavy one, and
 * it lives in one place only: the row's ✕. Nothing in the corner ends a
 * call any more, which is what makes the corner safe to reach for.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type MotionProps,
} from "motion/react";
import {
  Camera,
  CameraOff,
  ChevronDown,
  Mic,
  MicOff,
  SwitchCamera,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import {
  BottomSheet,
  PortalContainerProvider,
  Tooltip,
  cn,
} from "@vellumai/design-library";

import {
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  liveVoiceSurfaceLabelKey,
  minimizeVoiceRoom,
  setLiveVoiceMuted,
  setLiveVoiceOutputMuted,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { CameraShutter } from "@/domains/chat/voice/camera-shutter";
import { OAuthConnectSurface } from "@/domains/chat/components/surfaces/oauth-connect-surface";
import { handleSurfaceAction } from "@/domains/chat/surface-actions";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useSupportsNoninteractiveVoiceTurns } from "@/lib/backwards-compat/use-supports-noninteractive-voice-turns";
import { useSupportsVoiceCamera } from "@/lib/backwards-compat/use-supports-voice-camera";
import { AVATAR_ACCENT_CSS_VAR } from "@/hooks/use-avatar-accent-var";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";
import { toneForBg } from "@/utils/avatar-tone";

import { CameraFlashControl, nextFlashMode } from "./camera-flash-control";
import {
  CAMERA_MEDIA_GLASS_CLASS,
  CAMERA_SCRIM_BOTTOM,
  CAMERA_SCRIM_TOP,
  cameraModeStyle,
} from "./camera-mode-paint";
import {
  CameraStatusPill,
  useCameraStatusAnnouncement,
} from "./camera-status-pill";
import { useActiveConnectSurface } from "./use-active-connect-surface";
import { useCameraVoiceState } from "./use-camera-voice-state";
import { useChatHeaderBottom } from "./use-chat-header-bottom";
import { OVERLAY_HOST_ID, useInertBehindSheet } from "./use-inert-behind-sheet";
import { isVoiceCameraSupported } from "./voice-camera";
import { useVoiceRoomCamera } from "./use-voice-room-camera";
import { useVoiceRoomSight } from "./use-voice-room-sight";
import { toRoomLocal, useRoomBox } from "./use-room-box";
import { resolveWaveAccentHex } from "./wave-accent";

import {
  SAFE_AREA_BOTTOM,
  SAFE_AREA_LEFT,
  SAFE_AREA_RIGHT,
  SAFE_AREA_TOP,
} from "./voice-room-layout";

import { toVoiceAvatarVisual } from "./voice-avatar-state";
import {
  resolveVoiceRoomChoreography,
  sheetDragMinimizes,
  voidAvatarMotion,
} from "./voice-room-entrance";
import { VoiceAmbientTranscript } from "./voice-ambient-transcript";
import { VoiceAvatar } from "./voice-avatar";
import { VoiceRoomAmbientBackground } from "./voice-room-ambient-background";
import { useCustomAvatarFieldHex } from "./use-custom-avatar-field";
// Every circular icon control in the room is one of these: the corner
// minimize, the two mutes, the camera toggle, flip camera and end session. See
// that module for the toning, and for why the design library's `Button` is not
// the element here.
import {
  VoiceRoomControl,
  type VoiceRoomControlSurface,
} from "./voice-room-control";
import {
  VoiceRoomColorLook,
  VoiceRoomVoiceBands,
  VoiceStateCaption,
  resolveVoiceRoomLook,
  voiceRoomImageLook,
} from "./voice-room-eyes";
import { useIsVoiceRoomVisible } from "./use-is-voice-room-visible";

const AVATAR_SIZE = 220;

/**
 * Gap between a corner control and the room's edges. One constant so the
 * top-right exit and the bottom control row sit on the same rhythm.
 */
const CORNER_GAP = "1.25rem";

/**
 * Ceiling on the camera status pill, which is centred on the same line as the
 * top-right minimize control and grows in both directions from there. A
 * configured assistant name is arbitrarily long, so without this the pill runs
 * under that control and off a phone-width room. Each side gives up the corner
 * chrome's own offset, the control's 3.25rem box, and a gap so the two never
 * touch; a percentage resolves against the room, which is what the pill has to
 * fit inside.
 */
const CAMERA_PILL_MAX_WIDTH = `calc(100% - 2 * (max(${CORNER_GAP}, ${SAFE_AREA_RIGHT}) + 3.75rem))`;

/**
 * The flash button's accessible name, per state.
 *
 * It names the state and not the act, because the button has three states and
 * one press: "Turn flash on" would be a lie two thirds of the time.
 */
const FLASH_LABEL_KEYS = {
  off: "voiceRoom.flashOff",
  auto: "voiceRoom.flashAuto",
  on: "voiceRoom.flashOn",
} as const;

/** Placement variant. See the module docstring. */
export type VoiceRoomVariant = "fullscreen" | "content" | "sheet";

/**
 * The mobile sheet's tier inside the app shell's stacking context, overriding
 * the primitive's own `z-50`.
 *
 * The room rests below the thread header and leaves it usable, so everything
 * that header opens has to land in front of the room: the navigation drawer
 * (`z-40` in `chat-layout.tsx`) and, above that, the search palette (`z-50` in
 * `command-palette.tsx`, which also has to clear the drawer it opens over).
 * `z-30` is the shared tier for mobile surfaces that sit under the header, the
 * same one `mobile-app-overlay.tsx` and `mobile-document-overlay.tsx` use.
 *
 * This only orders the sheet against the app's own chrome. Menus and sheets
 * opened FROM the header (the conversation actions menu, the notifications
 * bell) portal to the body, outside the shell's stacking context, so they clear
 * the room by construction.
 */
const SHEET_LAYER = "z-30";

/**
 * The sheet's tier while it is flush for the camera. A takeover rather than a
 * surface under the header, so it rises above the tier the other mobile
 * overlays share with it in the portal host: one of those mounting mid-camera
 * would otherwise paint over the viewfinder in DOM order, inert and dead. The
 * drawer's tier, which the flush sheet follows in the DOM, and still under the
 * palette a hotkey can raise.
 */
const SHEET_FLUSH_LAYER = "z-40";

/**
 * Marks a `role="dialog"` element as belonging to the room, so the global
 * Escape handler can tell the room's own dialog apart from one layered over it.
 * Carried by whichever element is the dialog for the variant: the room's box
 * under `fullscreen` / `content`, the sheet's Radix content under `sheet`.
 */
const ROOM_DIALOG_ATTR = "data-voice-room";

/**
 * `BottomSheet.Content` with Motion attached, so `AnimatePresence` can play the
 * sheet's exit on the element Radix positions. The primitive forwards its ref
 * and spreads the rest onto Radix's content element, which is what
 * `motion.create` needs. Created at module scope: rebuilding it per render
 * would remount the sheet on every commit.
 */
const MotionBottomSheetContent = motion.create(BottomSheet.Content);

/**
 * The element the mobile sheet portals into.
 *
 * `root-layout.tsx` wraps the whole app shell in `isolation: isolate`, so a
 * sheet portaled to the body lands OUTSIDE that stacking context and paints
 * above everything in it whatever z-index the app uses, including the two
 * surfaces the header opens (the navigation drawer and the search palette).
 * `#viewport-overlays` puts the room back inside the shell, where
 * {@link SHEET_LAYER} orders it under both.
 *
 * Read synchronously on first render rather than only from an effect. The sheet
 * mounts fresh whenever the layout crosses into mobile, and a live session can
 * already be running at that moment (a desktop window narrowing mid-call): a
 * null first value would open the room against the `document.body` fallback,
 * reviving the stacking path this avoids, and then remount it into the host,
 * restarting the slide-up. The effect covers the one case the synchronous read
 * misses, the app's very first commit, where `RootLayout` mounts the container
 * in the same pass. No session can be live that early, so the room never opens
 * against the null.
 */
function useVoiceRoomPortalTarget(): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(() =>
    typeof document === "undefined"
      ? null
      : document.getElementById(OVERLAY_HOST_ID),
  );

  useEffect(() => {
    if (target) {
      return;
    }
    setTarget(document.getElementById(OVERLAY_HOST_ID));
  }, [target]);

  return target;
}

export function VoiceRoom({
  variant = "fullscreen",
}: {
  /** Placement variant. Defaults to the fullscreen (mobile) mount. */
  variant?: VoiceRoomVariant;
}) {
  const visible = useIsVoiceRoomVisible();
  const overlayTarget = useVoiceRoomPortalTarget();

  const room = (
    <AnimatePresence>
      {visible ? <VoiceRoomOverlay key="voice-room" variant={variant} /> : null}
    </AnimatePresence>
  );

  return variant === "sheet" ? (
    <PortalContainerProvider container={overlayTarget}>
      {room}
    </PortalContainerProvider>
  ) : (
    room
  );
}

/**
 * Sheet chrome for the mobile room.
 *
 * `open` is held true for as long as this renders: mounting is already gated by
 * `AnimatePresence` above, so letting Radix drive the open state as well would
 * unmount the content the instant the session ended and cut the room's exit
 * animation short. Radix therefore owns the entrance (its `data-[state=open]`
 * slide-up) and Motion owns the exit.
 *
 * Non-modal, which is the whole point of resting below the header rather than
 * covering it: the thread header stays lit and usable, matching the desktop
 * panel. That means suppressing three of Radix's modal reflexes, all of which
 * would otherwise contradict the design:
 *
 * - the dimming overlay, which greys out the header the sheet deliberately
 *   leaves showing. Radix drops this on its own once `modal` is false,
 * - the focus trap and pointer blocking, which would leave that header looking
 *   available while being inert,
 * - dismiss-on-outside-interaction, which would collapse the room the moment
 *   the user reached for the header they can now see.
 *
 * Escape is therefore left to the room's own handler, shared with the other
 * variants, rather than Radix's, so one keypress is one minimize.
 *
 * Flush to the top for the camera, it covers that chrome instead of resting
 * below it, and {@link useInertBehindSheet} takes the covered shell, the other
 * overlays sharing its portal host included, out of the tab order and the
 * accessibility tree for as long as it does. Not by turning
 * `modal` on: Radix renders a different content component per `modal`, so
 * flipping it mid-session would remount the sheet, replay the slide-up and
 * tear down the live viewfinder.
 *
 * The exit rides this element rather than the room's box inside it. Radix
 * portals the content out of the layout and positions it `fixed`, so it is the
 * outermost thing the sheet owns; sliding the room's box instead would travel
 * the look downward inside a stationary sheet and expose the page behind it.
 *
 * **The drag also rides this element, for the same reason.** A sheet that
 * slides up on its own should come back down under a finger, so the whole
 * chrome follows a downward pull and then either minimizes or springs back per
 * {@link sheetDragMinimizes}. It is pinned upward —
 * `dragConstraints` of zero in both directions with elasticity only on the
 * bottom — because there is nothing above the sheet to reveal: it already rests
 * against the header, and letting it travel up would open a gap under it. The
 * gesture is a *minimize*, never an end: pulling a live call off the screen
 * must not hang it up.
 */
function VoiceRoomSheet({
  headerBottom,
  flushToTop,
  motionProps,
  children,
}: {
  /** Where the sheet's top edge rests. See {@link useChatHeaderBottom}. */
  headerBottom: number;
  /**
   * Take the sheet to the top of the screen, square-cornered, rather than to
   * the header's edge. The camera's viewfinder fills the screen, so the sheet
   * framing it has to reach the same edges.
   */
  flushToTop: boolean;
  /** The slide-down exit. See `voice-room-entrance.ts`. */
  motionProps: MotionProps;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const contentRef = useRef<HTMLDivElement | null>(null);
  useInertBehindSheet(flushToTop, contentRef);
  return (
    <BottomSheet.Root open modal={false} onOpenChange={minimizeVoiceRoom}>
      <MotionBottomSheetContent
        ref={contentRef}
        {...motionProps}
        drag="y"
        // A voice room is a tall surface with controls near its bottom edge;
        // without the lock, the small vertical component of a horizontal
        // reach across the row starts the sheet moving under the finger.
        dragDirectionLock
        // Zero in both directions: the sheet has no resting position other
        // than "up". Downward travel is entirely `dragElastic`'s, which is
        // what makes let-go spring back rather than leaving the room parked
        // halfway down.
        dragConstraints={{ top: 0, bottom: 0 }}
        // Near-1:1 downward so the sheet tracks the finger, immovable upward.
        dragElastic={{ top: 0, bottom: 0.9 }}
        // The room is not a scroll view being flung; it should stop where the
        // finger stops and then resolve, not coast.
        dragMomentum={false}
        onDragEnd={(_event, info) => {
          if (sheetDragMinimizes(info.offset.y, info.velocity.y)) {
            minimizeVoiceRoom();
          }
        }}
        // The room is a surface in its own right: a full-bleed color fill and
        // bands that must reach the sheet's rounded corners.
        padded={false}
        // Override the primitive's default height band. The room is not a
        // menu sized to its rows; it fills everything between the header and
        // the bottom edge.
        className={cn(
          "top-[var(--voice-sheet-top)] max-h-none min-h-0 overflow-hidden border-t-0 bg-transparent p-0",
          flushToTop ? SHEET_FLUSH_LAYER : SHEET_LAYER,
          // Corners belong to a sheet that stops below the header. Against the
          // top of the screen they would cut two notches out of the feed.
          flushToTop && "rounded-t-none",
        )}
        // Marks the sheet as the room's own dialog. See {@link ROOM_DIALOG_ATTR}.
        {...{ [ROOM_DIALOG_ATTR]: "" }}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        // Radix focuses the first focusable child on open, which here is the
        // top-right minimize. That drew its focus ring and popped its tooltip
        // over a room the user had only just opened, so the first thing the
        // room said was how to leave it. Focus goes to the sheet itself
        // instead (Radix gives the content `tabIndex={-1}`), which
        // still announces the room and leaves Escape to the window handler
        // above.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.focus();
          }
        }}
        style={
          {
            "--voice-sheet-top": flushToTop ? "0px" : `${headerBottom}px`,
          } as CSSProperties
        }
        aria-label={t("voiceRoom.ariaLabel")}
        // The room narrates itself through its own live region; a description
        // element would be a second, redundant announcement.
        aria-describedby={undefined}
      >
        {children}
      </MotionBottomSheetContent>
    </BottomSheet.Root>
  );
}

/**
 * The mounted room. Split from {@link VoiceRoom} so its store subscriptions
 * only exist while the room is actually visible and are torn down cleanly on
 * exit.
 */
function VoiceRoomOverlay({ variant }: { variant: VoiceRoomVariant }) {
  const { t } = useTranslation("chat");
  const state = useLiveVoiceStore.use.state();
  const reconnecting = useLiveVoiceStore.use.reconnecting();
  // `speaking` stays set across a mid-turn tool run; gate `responding` on audio
  // actually flowing so the room reads `thinking` while the tool works.
  const assistantAudioActive = useLiveVoiceStore.use.assistantAudioActive();
  const liveAssistantId = useLiveVoiceStore.use.assistantId();
  const muted = useLiveVoiceStore.use.muted();
  // Muting the assistant needs no hands-free gate: it silences the output
  // rather than interrupting a turn, so there is no manual-session case where
  // it would end the whole call.
  const outputMuted = useLiveVoiceStore.use.outputMuted();
  // Viewport point the entrance grows from (the tapped voice button); null →
  // the color look falls back to its screen-center origin.
  const liveEntryOrigin = useLiveVoiceStore.use.entryOrigin();
  const reduce = useReducedMotion();

  // The room is one session, so freeze the avatar identity and the entry origin
  // at mount. Ending the session calls the store `reset()` (assistantId /
  // entryOrigin → null) while the room is still mounted for its exit animation;
  // reading the live values there would flip the look to the "V" fallback
  // mid-close and drop the shrink-to-origin target. The captured values hold for
  // the room's whole lifetime (both are session-constant).
  const [assistantId] = useState(liveAssistantId);
  const [entryOrigin] = useState(liveEntryOrigin);

  // The room's own rectangle. Everything in the look lays out against this, not
  // the window. As an inset panel they differ (see the module docstring).
  const { ref: roomRef, box } = useRoomBox();
  // Where the mobile sheet's top edge rests: the header's bottom in viewport
  // coordinates, since the sheet is `fixed`. Measured for every variant (hooks
  // cannot be conditional) but only read by the sheet.
  const headerBottom = useChatHeaderBottom();
  // The entry origin is a viewport point; the look lays out in room-local
  // space. Fullscreen's offset is zero, which makes this a no-op there.
  const localEntryOrigin = toRoomLocal(entryOrigin, box);

  const visual = toVoiceAvatarVisual(state, reconnecting, assistantAudioActive);
  // The label + sr-only announcement must follow the same audio-aware mapping as
  // the visual: a silent mid-turn `speaking` (ack spoken, tool now running)
  // reads as "Thinking…", not "Speaking…", so screen-reader users aren't told
  // the assistant is talking while it's actually silent (JARVIS-1279), and a
  // muted `listening` reads as "Muted", so they are not told it is hearing them
  // while the mic is off. Shared with the iOS Live Activity mirror and the
  // macOS companion, which show this exact string.
  //
  // Taken as a catalog key and resolved here, once, for every surface in the
  // room that shows it: the connect caption, the state announcer, and the
  // camera's status pill. The out-of-app mirrors take the same key and resolve
  // it through the same catalog, so one table decides the wording and every
  // surface reads it in the language the app is in.
  const stateLabelKey = liveVoiceSurfaceLabelKey(
    state,
    reconnecting,
    assistantAudioActive,
    muted,
  );
  const stateLabel = stateLabelKey ? t(stateLabelKey) : "";

  // The state caption (e.g. "Listening…") shows only while the assistant
  // transcript is hidden. Nothing in the room toggles that any more: the
  // preference is the Settings page's, read here.
  const showAssistantTranscript =
    useVoicePrefsStore.use.showAssistantTranscript();

  // Backwards-compat fallback for assistants that can still raise
  // `oauth_connect` mid-call — see use-supports-noninteractive-voice-turns.ts
  // (the canonical writeup); delete with the gate.
  const voiceTurnsAreNoninteractive =
    useSupportsNoninteractiveVoiceTurns(assistantId);
  const connectSurface = useActiveConnectSurface(!voiceTurnsAreNoninteractive);

  // The camera. Offered only when the device has one AND the session's
  // assistant understands the `attach_image` frame. See
  // `use-supports-voice-camera.ts` for why a photo that silently never
  // arrives is worse than no camera control at all.
  //
  // The viewfinder is a layer of THIS room, not a surface of its own, which is
  // the whole reason it can stay open across as many photos as the user wants:
  // there is nowhere for the camera to send them and nowhere to come back
  // from. Closing it returns to the look; the call never notices either way.
  // And because the stream is owned by a hook inside the room, minimizing (or
  // ending the call) unmounts this component and releases the camera without
  // anything having to remember to.
  const cameraSupported =
    useSupportsVoiceCamera(assistantId) && isVoiceCameraSupported();
  const viewfinderRef = useRef<HTMLVideoElement | null>(null);
  const { camera, sending, photos, errorKey, shutter, open, close } =
    useVoiceRoomCamera(assistantId, viewfinderRef);
  // The hook classifies the failure and names it; the room is where a
  // translator's `t` already is, so the sentence is resolved here. Same split
  // as the status pill's word below.
  const errorMessage = errorKey ? t(errorKey) : null;
  const cameraOpen = camera.open;
  // Sight rides the viewfinder the shutter already put on screen: while it is
  // open the gate keeps the frames worth keeping and parks each one on the
  // session as it lands, so whatever turn comes next carries the current view
  // and the call can be asked about what the camera is pointed at without
  // anyone pressing anything. Inert unless the flag and the session's assistant
  // both allow it, and it acquires no camera of its own, so the native shells
  // (where this `<video>` never mounts) simply sample nothing.
  const { heldFrame } = useVoiceRoomSight(assistantId, viewfinderRef, {
    cameraOpen,
    facing: camera.facing,
  });
  // What every control in the room is sitting on. One value passed down rather
  // than a boolean per control, so the row cannot end up half in camera mode.
  const controlSurface: VoiceRoomControlSurface = cameraOpen
    ? "camera"
    : "room";

  // Camera mode's own status readout. Gated on the camera so the user half is
  // only reported while something renders its dot, and the name is resolved the
  // way the first-run card resolves it.
  const cameraVoiceState = useCameraVoiceState(
    state,
    assistantAudioActive,
    cameraOpen,
  );
  const assistantName = useResolvedAssistantsStore.use
    .assistants()
    .find((a) => a.id === assistantId)?.name;
  // The one sentence camera mode says. Composed here rather than inside the
  // pill so the room's own always-mounted region speaks it: a live region that
  // arrives with its first sentence already in it is announced by nothing
  // reliable. Null while the camera is closed, where the region below carries
  // the session's plain label instead.
  const cameraAnnouncement = useCameraStatusAnnouncement(
    cameraOpen
      ? {
          voiceState: cameraVoiceState,
          statusLabel: stateLabel,
          assistantName,
          muted,
        }
      : null,
  );

  // The flash. A preference rather than a session setting, because the reason
  // someone turns it on (a dark room, a phone that under-exposes) outlives the
  // call it was turned on in. `useVoiceCamera` puts it on the camera; the room
  // only cycles it. See `voice-camera.ts` for why it is offered on so few
  // cameras.
  const flashMode = useVoicePrefsStore.use.flashMode();
  const setFlashMode = useVoicePrefsStore.use.setFlashMode();

  // Resolve the assistant's look. A character avatar hands over its palette
  // color and its eyes; an uploaded image hands over pixels, so the field color
  // is sampled out of it and the look carries no eyes (the room's centered
  // avatar is the centerpiece there). Null only while the avatar query is still
  // unresolved, which is the ambient-void loading state.
  //
  // The sample resolves a frame or more after the query does, and can fail
  // outright, so the room paints the void until it lands rather than holding
  // its first frame on a decode.
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);
  const customFieldHex = useCustomAvatarFieldHex(customImageUrl);
  const look =
    resolveVoiceRoomLook(components, traits, customImageUrl) ??
    (customFieldHex ? voiceRoomImageLook(customFieldHex) : null);
  const tone = look ? toneForBg(look.bgHex) : null;
  // The accent var, published for the void state's bands and mirrored by the
  // iOS Live Activity so island and room agree. Null for custom-image / "none"
  // / still-loading avatars, where those bands keep their own fallback.
  const accentHex = resolveWaveAccentHex(components, traits, customImageUrl);

  // Control-chrome colors for the active look, consumed by the shared control
  // classes. The fallbacks are the void look's white-on-dark values.
  const toneVars = {
    "--room-fg": tone?.fg ?? "#FFFFFF",
    "--room-fg-muted": tone?.fgMuted ?? "rgba(255,255,255,0.7)",
    "--room-wash": tone?.wash ?? "rgba(255,255,255,0.1)",
    "--room-border": tone?.wash ?? "rgba(255,255,255,0.15)",
    "--room-bubble-bg": tone?.bubbleBg ?? "rgba(255,255,255,0.16)",
    "--room-bubble-fg": tone?.bubbleFg ?? "#FFFFFF",
  } as CSSProperties;

  // Global Escape, live only while the room is mounted: minimizes the room,
  // same as the − control — the platform "leave the overlay" key dismisses
  // the surface without hanging up the call (✕ is the end-session control).
  // It fires even when the composer textarea (or any other focused element)
  // still holds focus as the room opens, so it is intentionally not guarded
  // by the event target.
  // Every variant, the sheet included: the sheet is non-modal, so it suppresses
  // Radix's own Escape handling and leaves the key to this one handler. One
  // keypress, one minimize, same behavior on every surface.
  const sheet = variant === "sheet";
  // How this surface comes and goes. The sheet already has an entrance, the
  // slide up, so its look is presented rather than grown and the slide-down
  // exit rides the sheet chrome. See `voice-room-entrance.ts`.
  const choreography = resolveVoiceRoomChoreography(variant, reduce === true);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      // A dialog layered over the room owns the key while it holds focus. The
      // navigation drawer and the search palette both sit above the room and
      // close themselves on Escape without stopping propagation, so an
      // unconditional minimize here dismisses two surfaces at once: the drawer
      // closes and the room vanishes behind it.
      //
      // Keyed on the focused dialog rather than the event target, which is what
      // keeps the unguarded behavior the room needs: the key still reaches us
      // when the composer textarea holds focus as the room opens, since that is
      // inside no dialog at all. The room's own dialog carries
      // {@link ROOM_DIALOG_ATTR} in every variant, including the sheet, whose
      // Radix content is the dialog and takes focus on open.
      const active = document.activeElement;
      const owner =
        active instanceof Element ? active.closest(`[role="dialog"]`) : null;
      if (owner && !owner.hasAttribute(ROOM_DIALOG_ATTR)) {
        return;
      }
      event.preventDefault();
      minimizeVoiceRoom();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const fullscreen = variant === "fullscreen";
  // The mobile sheet with the viewfinder up: it leaves the header's line and
  // goes full-bleed, so the camera is the whole screen rather than a feed
  // showing past a band of sheet chrome parked a third of the way down it.
  const cameraSheet = sheet && cameraOpen;
  // Where the room's top band sits, published on the box and read back through
  // `top-[var(--room-*)]` the way the tone colors are, so the pill and the
  // minimize control beside it share one line. Only the fullscreen room and the
  // flush camera sheet reach the notch: the former clamps its gap up to the
  // inset, the latter adds the gap to it so the grabber fits between. The panel
  // and the header-resting sheet start below the app's own chrome, where the
  // inset is not their edge to clear.
  const topBandVars = {
    "--room-chrome-top": fullscreen
      ? `max(${CORNER_GAP}, ${SAFE_AREA_TOP})`
      : cameraSheet
        ? `calc(${CORNER_GAP} + ${SAFE_AREA_TOP})`
        : CORNER_GAP,
    "--room-grabber-top": cameraSheet
      ? `calc(0.5rem + ${SAFE_AREA_TOP})`
      : "0.5rem",
  } as CSSProperties;

  const body = (
    <motion.div
      ref={roomRef}
      data-native-voice-camera-chrome
      className={cn(
        "z-50 flex items-center justify-center overflow-hidden",
        // z-50 orders the room's own box against the chat layout for the
        // fullscreen and panel variants; under the sheet it is scoped to the
        // sheet's stacking context, whose tier is {@link SHEET_LAYER}.
        // `overflow-hidden` above is what clips the full-bleed color/wave
        // layers to whatever radius the variant carries: the panel's corners on
        // desktop, the sheet's top corners on mobile.
        fullscreen && "fixed inset-0",
        variant === "content" && "absolute inset-0 rounded-xl",
        // The sheet's own box is the Radix content element, which is already
        // positioned and rounded; the room fills it.
        sheet && "absolute inset-0 rounded-t-[24px]",
        // Square with the sheet, so the clip follows the chrome to the top of
        // the screen instead of shaving the feed's corners.
        cameraSheet && "rounded-t-none",
      )}
      // Theme tokens (the connect label, the ambient transcript) follow the
      // look: dark over the void and the dark avatar colors, light over the
      // light one (yellow).
      data-theme={tone?.isLight ? "light" : "dark"}
      // The sheet's Radix content element is the dialog; a second `role` and
      // label nested inside it would announce the room twice.
      role={sheet ? undefined : "dialog"}
      // Marks this box as the room's own dialog for the variants where it is
      // one. See {@link ROOM_DIALOG_ATTR}; the sheet carries it on its content.
      {...{ [ROOM_DIALOG_ATTR]: "" }}
      // Only the fullscreen room is modal by its own declaration. The content
      // variant deliberately leaves the header and sidenav usable, so claiming
      // the rest of the app is inert would be a lie to assistive tech; the
      // sheet gets real modality from Radix instead of asserting it here.
      aria-modal={fullscreen || undefined}
      aria-label={sheet ? undefined : t("voiceRoom.ariaLabel")}
      // Fullscreen covers `ChatLayoutHeader`, so it loses the header's
      // safe-area protection — pad the centered avatar inside the
      // notch/home-indicator per docs/CAPACITOR.md. The background layers are
      // `absolute inset-0` and stay full-bleed behind the padding. The content
      // variant sits inside the layout, which already handles its own insets.
      style={{
        ...(fullscreen
          ? {
              paddingTop: SAFE_AREA_TOP,
              paddingBottom: SAFE_AREA_BOTTOM,
              paddingLeft: SAFE_AREA_LEFT,
              paddingRight: SAFE_AREA_RIGHT,
            }
          : null),
        ...topBandVars,
        ...toneVars,
        ...(accentHex ? { [AVATAR_ACCENT_CSS_VAR]: accentHex } : {}),
      }}
      // On close the chrome and rectangular backgrounds fade, while the avatar
      // shape itself shrinks back toward the entry origin (the character
      // look's body + eyes and the centered avatar each own that exit), so
      // the room collapses into the avatar, not a shrinking rectangle. Under
      // the sheet none of that applies: the chrome slides the whole room out in
      // one piece, and this box holds still.
      {...choreography.shell}
    >
      {/* The look: a color field plus the room's shared cast (voice bands,
          state caption, and the eyes when the avatar has any). A custom-image
          avatar takes the same path with its sampled field color and no eyes,
          so nothing about the bands or the caption depends on avatar type; the
          centered avatar below fills the middle in its place. */}
      {!camera.native && look ? (
        // Held back until the box is measured. That is one pre-paint commit, so the
        // entrance still plays from the room's first painted frame, but it
        // grows inside a real rectangle rather than a zero-sized one.
        box ? (
          <VoiceRoomColorLook
            look={look}
            visual={visual}
            getAmplitude={getLiveVoiceInputAmplitude}
            getResponseAmplitude={getLiveVoiceOutputAmplitude}
            // While assistant captions are on, the transcript's lower zone
            // already narrates the turn from the caption's own baseline, so the
            // caption stands down rather than doubling it. The user-only caption
            // pref leaves it up (a user pill alone doesn't name the assistant's
            // state).
            showStateCaption={!showAssistantTranscript}
            entryOrigin={localEntryOrigin}
            entrance={choreography.entrance}
            viewport={box}
          />
        ) : null
      ) : !camera.native ? (
        <>
          {/* No avatar resolved yet, so there is no field to paint. The bands
              are the same component at the same edge; only the ink changes,
              because the dark voice ink cannot be seen on the void. */}
          <VoiceRoomAmbientBackground />
          <VoiceRoomVoiceBands
            visual={visual}
            getAmplitude={getLiveVoiceInputAmplitude}
            getResponseAmplitude={getLiveVoiceOutputAmplitude}
            ink="accent"
            viewport={box ?? undefined}
          />
          {!showAssistantTranscript ? (
            <VoiceStateCaption visual={visual} />
          ) : null}
        </>
      ) : null}

      {/* The browser-fallback viewfinder, when the camera is open.

          Capacitor mobile shells render their native camera preview behind the
          transparent web view and need no media element. Browsers and older
          shells render this full-bleed `<video>` over the look instead.

          `z-[2]` puts it above every layer of both looks (the color field and
          the void avatar sit at `z-0`, the giant eyes and the state caption at
          `z-[1]`) while staying under the room's chrome at `z-10`, so the
          transcript and the controls keep reading over the feed. Ordering it
          by DOM position alone is not enough: the void look's centred avatar
          renders after this and would paint straight over the viewfinder.

          `object-cover` because the video track's aspect ratio is the camera's,
          not the room's, and letterboxing a viewfinder makes it read as a photo
          already taken. The front camera is mirrored, matching every other
          selfie viewfinder on the platform; the rear one is not, because it
          shows the world and a mirrored world is unusable for aiming.

          Muted + playsInline + autoPlay lets the fallback stream start inline;
          `aria-hidden` because a live camera feed has nothing to announce and
          the controls below carry the accessible names. */}
      {cameraOpen && !camera.native ? (
        <video
          ref={viewfinderRef}
          data-testid="voice-room-viewfinder"
          aria-hidden
          autoPlay
          muted
          playsInline
          className={cn(
            "absolute inset-0 z-[2] size-full object-cover",
            camera.facing === "user" && "-scale-x-100",
          )}
        />
      ) : null}

      {/* Legibility scrims for the two bands the camera chrome lives in.

          The chrome over a viewfinder has no background it can count on: the
          status pill's own glass holds up over most frames, but a white wall
          under the top band or a bright sky under the bottom one takes the
          whole row with it. A gradient darkens just enough at the edges to
          keep it readable and fades to nothing before the middle of the frame,
          which is the part the user is aiming.

          Above the feed (`z-[2]`) and below the chrome (`z-10`), and inert:
          they cover the shutter and the control row, so anything else would
          swallow every press in the bottom third. Rendered for the native
          preview too, which sits behind the transparent web view and needs the
          scrim just as much. */}
      {cameraOpen ? (
        <>
          <div
            aria-hidden
            data-testid="voice-room-scrim-top"
            className="pointer-events-none absolute inset-x-0 top-0 z-[3] h-[22%]"
            style={{ background: CAMERA_SCRIM_TOP }}
          />
          {/* The floor is what carries the scrim past the shutter in a short
              room: 38% of a 500px panel stops above it, leaving the one control
              meant to be the brightest thing on screen sitting on bare frame.
              15rem clears the shutter's own row and the control row under it. */}
          <div
            aria-hidden
            data-testid="voice-room-scrim-bottom"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] h-[max(38%,15rem)]"
            style={{ background: CAMERA_SCRIM_BOTTOM }}
          />
        </>
      ) : null}

      {/* Optional live transcript, rendered into the room's two text zones —
          the user's speech above the eyes, the assistant's below. Pref-gated
          (the captions control above) and absolutely positioned in the margins
          the centerpiece leaves free, so it never shifts the centered avatar
          and stays absent by default. */}
      <VoiceAmbientTranscript />

      {/* Backwards-compat fallback card for assistants that can still raise
          `oauth_connect` mid-call — see use-supports-noninteractive-voice-turns.ts;
          delete this slot with the gate. */}
      <AnimatePresence>
        {connectSurface ? (
          <motion.div
            key={`connect-${connectSurface.surfaceId}`}
            className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4"
            style={{ bottom: `calc(6rem + ${SAFE_AREA_BOTTOM})` }}
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
          >
            <div className="pointer-events-auto w-full max-w-[28rem]">
              <OAuthConnectSurface
                surface={connectSurface}
                assistantId={assistantId}
                onAction={(surfaceId, actionId, data) => {
                  void handleSurfaceAction(surfaceId, actionId, data);
                }}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* The sheet's grabber: the whole affordance for the pull-down, and the
          only thing on the surface that says the room can be pulled at all.
          A caption telling the user to swipe would be read by nobody; the bar
          every sheet on the platform wears is the shape they already know.

          Decorative, and deliberately not a hit target of its own: the drag
          lives on the sheet chrome and so the ENTIRE room answers the gesture,
          which is what makes it findable without aiming. Sheet only — the
          desktop panel and the fullscreen room have no chrome to pull. */}
      {sheet ? (
        <div
          aria-hidden
          data-testid="voice-room-grabber"
          className="pointer-events-none absolute left-1/2 top-[var(--room-grabber-top)] z-10 h-1 w-9 -translate-x-1/2 rounded-full bg-[var(--room-fg-muted)] opacity-60"
        />
      ) : null}

      {/* Camera mode's status readout: what the camera is doing, and what the
          session is doing. Top-centre, on the same offset the corner chrome
          uses, so it shares a line with the minimize control instead of
          floating on a rhythm of its own; that offset already clears the
          sheet's grabber.

          Camera-only. With the viewfinder closed the room says all of this
          through the look itself (the avatar's visual, the state caption, the
          bands), and a pill repeating it would be a second answer to a question
          nobody asked. */}
      {cameraOpen ? (
        <div
          data-testid="camera-status-pill-slot"
          className="pointer-events-none absolute left-1/2 top-[var(--room-chrome-top)] z-10 -translate-x-1/2"
          style={{ maxWidth: CAMERA_PILL_MAX_WIDTH }}
        >
          <CameraStatusPill
            voiceState={cameraVoiceState}
            statusLabel={stateLabel}
            assistantName={assistantName}
          />
        </div>
      ) : null}

      {/* Top-right: minimize, alone.

          The corner is where every other surface in the app puts "get this off
          my screen", and that is now exactly what it does — the session keeps
          running on the composer's voice bar or the title-bar pill. It used to
          END the call, which put the most destructive act in the room at the
          one spot muscle memory reaches for without looking; hanging up moved
          into the control row below, where it sits among the other things you
          do to a call and has to be aimed at.

          Never gated behind avatar readiness, so the room can always be
          dismissed even mid-load / on failure. Nothing else shares the corner:
          the in-session settings gear was deleted because a cluster of small
          chrome competed with the room's own cast for attention. Voice and
          listening language are Settings' now. */}
      <div
        // An equal gap from both edges, so the control reads as sitting in the
        // corner rather than floating near it. The top comes off the room's own
        // band, shared with the camera pill; see `--room-chrome-top`.
        style={{ right: `max(${CORNER_GAP}, ${SAFE_AREA_RIGHT})` }}
        className="absolute top-[var(--room-chrome-top)] z-10 flex items-center gap-1"
      >
        <VoiceRoomControl
          label={t("voiceRoom.minimizeAria")}
          tooltip={t("voiceRoom.minimizeTooltip")}
          onClick={minimizeVoiceRoom}
          bare
          surface={controlSurface}
        >
          <ChevronDown className="size-5" />
        </VoiceRoomControl>
      </div>

      {/* The centerpiece for every assistant without eyes: an uploaded image,
          or none resolved yet. It springs to center once on entry (the wrapper
          owns the one-time entry spring); the phases that express themselves on
          the avatar do it through its own CSS loop, cross-fading in place
          without re-popping, and `responding` holds still while the band at the
          floor carries the turn. A character look has no centered figure: its
          eyes are the cast. */}
      {!camera.native && !look?.art ? (
        <motion.div
          className="relative z-0"
          {...voidAvatarMotion(choreography.entrance)}
        >
          <VoiceAvatar
            assistantId={assistantId}
            visual={visual}
            size={AVATAR_SIZE}
          />
        </motion.div>
      ) : null}

      {/* Connect feedback: until the session reaches `listening` the avatar
          shows the idle visual, which otherwise reads as dead air — surface
          the "Connecting…" / "Reconnecting…" label so the user knows when to
          start talking. aria-hidden: the sr-only live region below already
          announces every state change. */}
      <AnimatePresence>
        {state === "connecting" ? (
          <motion.p
            key="connect-label"
            data-testid="voice-room-connect-label"
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-[calc(50%+8.5rem)] z-0 -translate-x-1/2 text-sm text-[var(--content-tertiary)]"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
          >
            {stateLabel}
          </motion.p>
        ) : null}
      </AnimatePresence>

      {/* The session controls: one centred row near the bottom, reading
          left to right as the three things a caller does mid-call.

          - mute the mic, so the assistant stops hearing you,
          - mute the assistant, so you stop hearing it. Its reply keeps running
            underneath and the transcript keeps filling, so unmuting drops you
            back in wherever it has reached,
          - end the session.

          The two mutes are a symmetric pair: one per direction of the
          conversation, reading left to right as you and then it. The end
          control closes the row, and it is the room's ONLY one, so there is
          exactly one place a session can be ended from.

          A red ✕, not a hang-up receiver. This is not truly a phone call —
          it is a session you are in, the same one the composer's ✕ ends and
          the same one the pill's ✕ ends — and a receiver glyph would be the
          only place in the app that called it something else.

          It wears the destructive tone unconditionally, rather than the
          neutral one the mutes wear until engaged, precisely because the row
          it joined is otherwise all reversible toggles: a third identical
          circle beside them would collect the mis-tap that cannot be undone.
          Every control here is persistent, so the row never changes shape
          mid-call and none moves out from under a reaching finger. */}
      {/* The shutter, and the camera's own failures.

          A row of its own, above the session controls. The shutter is the big
          target because it is the one thing the user does repeatedly while
          holding a phone at arm's length pointed at something; the session
          controls below stay their usual size, so the thing you press often
          never sits flush against the thing that hangs up.

          The row also carries the camera's failures, and so it renders when
          there is a failure to report even though the viewfinder never came
          up. A denied permission is precisely the case where it did not, and
          nesting the message inside the open state left the camera button
          appearing to do nothing at all.

          The shutter does not close the camera. Taking a photo is a step in a
          conversation ("what's this?" … "and this one?"), not the end of one,
          and a viewfinder that dismissed itself per photo would make every
          follow-up cost another open/aim/expose cycle, which is exactly the
          system-camera behavior this surface exists to avoid. */}
      {cameraOpen || errorMessage ? (
        <div
          data-testid="voice-room-camera-controls"
          className="absolute inset-x-0 z-10 flex flex-col items-center gap-3"
          // The session row's own offset, plus its 52px height, plus the 46px
          // the design leaves between the two. Composed from the row's top edge
          // rather than written as one constant: the thing you press often has
          // to stay off the thing that hangs up, and it is the GAP that
          // guarantees that, not the number.
          style={{
            bottom: `calc(6.125rem + max(${CORNER_GAP}, ${SAFE_AREA_BOTTOM}))`,
          }}
        >
          {errorMessage ? (
            // Visual only. A live region carrying its own first content is
            // announced unreliably, since assistive tech watches an existing
            // region for changes rather than a new one for arrival, and this
            // element mounts with the message already in it. The always-mounted
            // region at the foot of the room speaks it instead.
            <p
              aria-hidden
              data-testid="voice-room-camera-error"
              className={cn(
                "rounded-full px-3 py-1 text-xs",
                // Same reason the controls get a scrim: a failed send reported
                // in tone-derived text over the feed is a message nobody can
                // read. Camera-closed (a denied permission, the case where the
                // viewfinder never came up) keeps the room's own treatment.
                cameraOpen
                  ? CAMERA_MEDIA_GLASS_CLASS
                  : "bg-[var(--room-wash)] text-[var(--room-fg)]",
              )}
            >
              {errorMessage}
            </p>
          ) : null}
          {/* What the shutter did.

              A photo taken on a call goes somewhere the user cannot see: the
              viewfinder does not change, the assistant may say nothing for
              seconds, and the transcript is behind the room. Without this the
              press is indistinguishable from a dead button, which is what
              sends people pressing it again.

              A strip of recent frames rather than a confirmation step, because
              the question is "did that go?", which can only be answered after
              the fact. A dialog before the send would interrupt the one action
              this surface is built to repeat, and still would not answer it.
              The shutter press is the consent.

              Dimmed while in flight, struck through when it failed, plain when
              the assistant has it. Aligned left so it never sits under the
              shutter, and `aria-hidden` because the live region already
              announces failures in words. */}
          {photos.length > 0 || heldFrame ? (
            <div className="flex items-center gap-2 self-start pl-6">
              {photos.length > 0 ? (
                <ul
                  aria-hidden
                  data-testid="voice-room-photo-strip"
                  className="flex items-center gap-2"
                >
                  {photos.map((photo) => (
                    <li key={photo.id} className="relative">
                      <img
                        src={photo.previewUrl}
                        alt=""
                        data-testid="voice-room-photo"
                        data-status={photo.status}
                        className={cn(
                          "size-11 rounded-lg border object-cover transition",
                          "border-[var(--room-border)]",
                          photo.status === "sending" && "opacity-50",
                          photo.status === "failed" && "opacity-40 grayscale",
                        )}
                      />
                      {photo.status === "failed" ? (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <X className="size-5 text-red-300" strokeWidth={3} />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {/* The view the call is holding right now.

                  A photo in the strip is a receipt for something the user did;
                  this is the opposite, a frame nobody asked for that the next
                  turn can carry, so it has to be visible while that is still
                  true rather than after the fact. It wears the strip's shape so
                  the two read as one row, and the capture accent so they are
                  not read as the same thing. Keyed on the id, which replays the
                  ring whenever a newer frame takes the slot.

                  `aria-hidden` for the same reason as the strip: the frame
                  reaches the transcript with the turn it rides, which is the
                  accessible record of it. */}
              {heldFrame ? (
                <img
                  key={heldFrame.attachmentId}
                  src={heldFrame.previewUrl}
                  alt=""
                  aria-hidden
                  data-testid="voice-room-sight-frame"
                  style={cameraModeStyle()}
                  className="sight-frame-kept size-11 rounded-lg object-cover ring-2 ring-[var(--camera-accent)]"
                />
              ) : null}
            </div>
          ) : null}

          {/* The shutter is centred on the room, with flip parked off to the
              side rather than sharing a row with it: a two-item row would put
              the shutter off-centre, and the shutter is the target the user
              reaches for without looking. */}
          {cameraOpen ? (
            <div className="relative flex w-full items-center justify-center">
              {/* Flash on the left, flip on the right, shutter between them:
                  the two things that change how the next photo comes out sit
                  either side of the one that takes it, and neither can be hit
                  by a thumb reaching for the middle.

                  Present only where it does something. The browser fallback
                  path cannot fire a flash at all, and a native camera with no
                  flash unit reports none, so on both this is absent rather
                  than a dead control the user has to discover is dead. */}
              {camera.flashAvailable ? (
                <Tooltip content={t(FLASH_LABEL_KEYS[flashMode])}>
                  <CameraFlashControl
                    mode={flashMode}
                    ariaLabel={t(FLASH_LABEL_KEYS[flashMode])}
                    autoBadge={t("voiceRoom.flashAutoBadge")}
                    onClick={() => setFlashMode(nextFlashMode(flashMode))}
                    // The design's own offset. It is not flip's on the other
                    // side: the design places the two flanks independently, so
                    // matching them to each other is a departure from it.
                    className="absolute left-11"
                    testId="voice-room-flash"
                  />
                </Tooltip>
              ) : null}

              {/* The one control with no surface branch: the shutter exists
                  only while the viewfinder does, so it is never seen against
                  anything but video. Photo is the only mode the capture path
                  reaches. */}
              <Tooltip content={t("voiceRoom.takePhoto")}>
                <CameraShutter
                  onClick={() => void shutter()}
                  ariaLabel={t("voiceRoom.takePhoto")}
                  capturing={sending}
                  // Also held off while a flip swaps the capture: the
                  // viewfinder stays up with nothing behind it, and a press
                  // there would report a failure for a working flip.
                  disabled={sending || camera.flipping}
                  testId="voice-room-shutter"
                />
              </Tooltip>

              <VoiceRoomControl
                label={t("voiceRoom.flipCamera")}
                onClick={() => void camera.flipCamera()}
                surface={controlSurface}
                className="absolute right-[30px]"
              >
                <SwitchCamera className="size-5" />
              </VoiceRoomControl>
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        data-testid="voice-room-controls"
        className="absolute inset-x-0 z-10 flex items-center justify-center gap-4"
        // The bottom edge IS the screen's on the sheet and fullscreen, so the
        // home-indicator inset is real here in a way the top inset was not.
        style={{ bottom: `max(${CORNER_GAP}, ${SAFE_AREA_BOTTOM})` }}
      >
        <VoiceRoomControl
          label={
            muted
              ? t("voiceRoom.unmuteMicrophone")
              : t("voiceRoom.muteMicrophone")
          }
          onClick={() => setLiveVoiceMuted(!muted)}
          pressed={muted}
          // With the viewfinder up, the room's face is covered and this button
          // is the only thing on screen saying the session can still hear you.
          // A live mic therefore goes solid white rather than sitting on the
          // same glass as the controls around it, where the answer would be an
          // absence of red.
          tone={muted ? "destructive" : "live"}
          isLight={tone?.isLight}
          surface={controlSurface}
        >
          {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </VoiceRoomControl>

        <VoiceRoomControl
          label={
            outputMuted
              ? t("voiceRoom.unmuteAssistant")
              : t("voiceRoom.muteAssistant")
          }
          onClick={() => setLiveVoiceOutputMuted(!outputMuted)}
          pressed={outputMuted}
          tone={outputMuted ? "destructive" : "neutral"}
          isLight={tone?.isLight}
          surface={controlSurface}
        >
          {outputMuted ? (
            <VolumeX className="size-5" />
          ) : (
            <Volume2 className="size-5" />
          )}
        </VoiceRoomControl>

        {/* Show the assistant what you're looking at.

            Sits with the mutes rather than in the corner because it is the
            same kind of act: a thing you do TO the running call, reversible,
            and not the one that ends it.

            Neutral in both states, and the icon names the ACTION rather than
            the state. That is the one place this row departs from the mutes beside
            it. The mutes have to display state because muted-ness is
            invisible; an open camera is the single most visible thing on the
            screen, so a second indicator would be telling the user something
            they are already looking at, and the red "engaged" treatment would
            put a warning colour on a control that has done nothing alarming.

            No pre-permission sheet stands between this tap and
            `getUserMedia`, per docs/CAPACITOR.md § OS permission requests on
            iOS: the button IS the pre-prompt, and pressing it raises the
            system alert directly. Any explanatory step added here would have
            to be undismissable to stay compliant, which for a control this
            self-evident would be worse than nothing. */}
        {cameraSupported ? (
          <VoiceRoomControl
            label={
              cameraOpen
                ? t("voiceRoom.closeCamera")
                : t("voiceRoom.showCamera")
            }
            onClick={() => (cameraOpen ? close() : void open())}
            pressed={cameraOpen}
            surface={controlSurface}
            data-testid="voice-room-camera-toggle"
          >
            {cameraOpen ? (
              <CameraOff className="size-5" />
            ) : (
              <Camera className="size-5" />
            )}
          </VoiceRoomControl>
        ) : null}

        <VoiceRoomControl
          label={t("voiceRoom.endSessionAria")}
          tooltip={t("voiceRoom.endSessionTooltip")}
          onClick={endLiveVoiceSession}
          tone="destructive"
          isLight={tone?.isLight}
          surface={controlSurface}
        >
          <X className="size-5" strokeWidth={2.5} />
        </VoiceRoomControl>
      </div>

      {/* Screen readers get session-state changes here; the avatar is the
          visual channel, so this stays off-screen.

          One region across both looks, rather than a second one appearing with
          the viewfinder. Assistive tech announces a change made INSIDE a region
          it was already watching, not the arrival of a region that comes with
          its words already in it, so the camera's sentence is written into this
          one and the pill above stays a drawing. */}
      <div
        aria-live="polite"
        className="sr-only"
        data-testid="voice-room-state-announcer"
      >
        {/* With the camera open the sentence leads with the mode word and
            carries the mute prefix itself (see `useCameraStatusAnnouncement`),
            so the room says the state once rather than twice.

            Closed, a muted `listening` already reads as "Muted", so prefixing
            it again would announce "Muted. Muted". The assistant's own phases
            still need the prefix: "Thinking…" alone would not say the mic is
            off. */}
        {cameraOpen
          ? cameraAnnouncement
          : muted && state !== "listening"
            ? t("voiceRoom.mutedState", { state: stateLabel })
            : stateLabel}
      </div>

      {/* The camera's own failures, in words.

          A region of its own rather than a branch of the one above, because the
          two answer different questions and a failure stands until the camera is
          opened or closed again: folding it in would silence every state change
          for as long as the message lasted. Mounted whether or not there is
          anything to say, since assistive tech announces a change made INSIDE a
          region it was already watching, not the arrival of a region that comes
          with its words already in it. */}
      <div
        aria-live="polite"
        className="sr-only"
        data-testid="voice-room-camera-announcer"
      >
        {errorMessage ?? ""}
      </div>
    </motion.div>
  );

  return sheet && choreography.sheetChrome ? (
    <VoiceRoomSheet
      headerBottom={headerBottom}
      flushToTop={cameraSheet}
      motionProps={choreography.sheetChrome}
    >
      {body}
    </VoiceRoomSheet>
  ) : (
    body
  );
}
