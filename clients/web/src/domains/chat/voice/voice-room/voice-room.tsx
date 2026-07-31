/**
 * "Voice room" — the owning-composer surface for a live-voice session,
 * mounted by `chat-layout.tsx` as a purely additive overlay: the composer's
 * voice bar and display transcript still render underneath, hidden by this
 * layer, so removing the room leaves the old UI intact.
 *
 * Two looks, resolved per session assistant ({@link resolveVoiceRoomLook}):
 *
 * - Character avatars get the onboarding "full-screen color with eyes"
 *   treatment — entering the room plays the Introduction-step grow (the
 *   avatar's body springs from its on-screen size to BE the screen, the color
 *   fades in behind it, the giant eyes grow into the center; see
 *   {@link VoiceRoomColorLook}), the mic waveform swells behind the eyes while
 *   the user speaks, and the control chrome is toned for contrast against that
 *   color ({@link toneForBg}, via the `--room-*` CSS vars).
 * - Custom-image / no-character avatars fall back to the deep-dark ambient
 *   void with the state-driven avatar at its center and the listening waves —
 *   what this look should become is an open design question.
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
 *   the DOM. Non-modal, so the header it rests below stays lit and usable,
 *   which takes suppressing several of Radix's modal reflexes: see
 *   {@link VoiceRoomSheet}. Because the slide IS its entrance, the look inside
 *   is painted rather than grown. See `voice-room-entrance.ts`.
 * - `"fullscreen"`: `fixed inset-0` over the whole viewport, modal, with
 *   safe-area padding for notched iOS shells. No longer mounted by the chat
 *   layout; kept as the variant a surface with no chrome to sit under would
 *   want, and the default.
 *
 * The look is laid out against the ROOM's box, not the window's. See
 * {@link useRoomBox}. As a panel those are different rectangles, so the color
 * look's field, its giant eyes, and the responding rings are all sized to the
 * panel, and the entry origin (published in viewport space by the composer) is
 * converted to room-local space before the entrance grows from it. The sheet
 * reads no origin: it presents the look rather than growing it.
 *
 * The room is not exit-only. Minimizing (the "show transcript" control or
 * Escape) dismisses the room while the session keeps running, handing the
 * session to the composer's voice bar or the title-bar pill; ending the
 * session (the ✕ control) tears the whole call down.
 *
 * Visibility is a pure function of {@link useIsVoiceRoomVisible} — active
 * session, owned by the on-screen composer, main window, not minimized. Any
 * session end (user exit, `failed`, conversation timeout, stop from
 * elsewhere) flips that predicate false and unmounts the room; a `failed`
 * session surfaces through the existing composer Notice / pill failure chip,
 * never a dead room.
 *
 * Sessions are hands-free (server-VAD): the user just speaks, so there is no
 * push-to-talk control. One centred row near the bottom carries the three
 * things a caller does mid-call, left to right: mute the mic so it stops
 * hearing you, mute the assistant so you stop hearing it, and show the
 * transcript, which minimizes the room to reveal the conversation with the call
 * still running. All three are persistent toggles, so the row never changes
 * shape mid-call. Exit is first-class and kept away from that row: the
 * persistent ✕ sits alone top-right, always rendered even while the
 * avatar/assistant data is loading or failed. Escape maps to the same lesser
 * dismissal as show transcript, leaving the call live. The key handler
 * attaches only while the room is mounted.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type MotionProps,
} from "motion/react";
import { Captions, Mic, MicOff, Volume2, VolumeX, X } from "lucide-react";

import { BottomSheet, Tooltip, cn } from "@vellumai/design-library";

import {
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  liveVoiceSurfaceLabel,
  minimizeVoiceRoom,
  setLiveVoiceMuted,
  setLiveVoiceOutputMuted,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { OAuthConnectSurface } from "@/domains/chat/components/surfaces/oauth-connect-surface";
import { handleSurfaceAction } from "@/domains/chat/surface-actions";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useSupportsNoninteractiveVoiceTurns } from "@/lib/backwards-compat/use-supports-noninteractive-voice-turns";
import { AVATAR_ACCENT_CSS_VAR } from "@/hooks/use-avatar-accent-var";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";
import { toneForBg } from "@/utils/avatar-tone";

import { useActiveConnectSurface } from "./use-active-connect-surface";
import { useChatHeaderBottom } from "./use-chat-header-bottom";
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
  voidAvatarMotion,
} from "./voice-room-entrance";
import { VoiceAmbientTranscript } from "./voice-ambient-transcript";
import { VoiceAvatar } from "./voice-avatar";
import { VoiceMeshWaves } from "./voice-mesh-waves";
import { VoiceRoomAmbientBackground } from "./voice-room-ambient-background";
import {
  VoiceRespondingRings,
  VoiceRoomColorLook,
  VoiceStateCaption,
  resolveVoiceRoomLook,
} from "./voice-room-eyes";
import { useIsVoiceRoomVisible } from "./use-is-voice-room-visible";

const AVATAR_SIZE = 220;

/**
 * Gap between a corner control and the room's edges. One constant so the
 * top-right exit and the bottom control row sit on the same rhythm.
 */
const CORNER_GAP = "1.25rem";

/**
 * Shared treatment for the room's top icon controls, toned to the active look
 * via the `--room-*` vars set on the root (white-on-dark for the void look,
 * tone-derived over an avatar color).
 */
const ROOM_CONTROL_CLASS =
  "flex size-12 items-center justify-center rounded-full text-[var(--room-fg-muted)] transition hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--room-fg-muted)]";

/** The centred row's circular session controls, same toning. */
const SESSION_CONTROL_CLASS =
  "flex size-12 items-center justify-center rounded-full border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--room-fg-muted)]";
const SESSION_CONTROL_NEUTRAL_CLASS =
  "border-[var(--room-border)] text-[var(--room-fg-muted)] hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)]";

/** Placement variant. See the module docstring. */
export type VoiceRoomVariant = "fullscreen" | "content" | "sheet";

/**
 * `BottomSheet.Content` with Motion attached, so `AnimatePresence` can play the
 * sheet's exit on the element Radix positions. The primitive forwards its ref
 * and spreads the rest onto Radix's content element, which is what
 * `motion.create` needs. Created at module scope: rebuilding it per render
 * would remount the sheet on every commit.
 */
const MotionBottomSheetContent = motion.create(BottomSheet.Content);

export function VoiceRoom({
  variant = "fullscreen",
}: {
  /** Placement variant. Defaults to the fullscreen (mobile) mount. */
  variant?: VoiceRoomVariant;
}) {
  const visible = useIsVoiceRoomVisible();

  return (
    <AnimatePresence>
      {visible ? <VoiceRoomOverlay key="voice-room" variant={variant} /> : null}
    </AnimatePresence>
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
 * The exit rides this element rather than the room's box inside it. Radix
 * portals the content out of the layout and positions it `fixed`, so it is the
 * outermost thing the sheet owns; sliding the room's box instead would travel
 * the look downward inside a stationary sheet and expose the page behind it.
 */
function VoiceRoomSheet({
  headerBottom,
  motionProps,
  children,
}: {
  /** Where the sheet's top edge rests. See {@link useChatHeaderBottom}. */
  headerBottom: number;
  /** The slide-down exit. See `voice-room-entrance.ts`. */
  motionProps: MotionProps;
  children: ReactNode;
}) {
  return (
    <BottomSheet.Root open modal={false} onOpenChange={minimizeVoiceRoom}>
      <MotionBottomSheetContent
        {...motionProps}
        // The room is a surface in its own right: a full-bleed color fill and
        // bands that must reach the sheet's rounded corners.
        padded={false}
        // Override the primitive's default height band. The room is not a
        // menu sized to its rows; it fills everything between the header and
        // the bottom edge.
        className="top-[var(--voice-sheet-top)] max-h-none min-h-0 overflow-hidden border-t-0 bg-transparent p-0"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        // Radix focuses the first focusable child on open, which here is the
        // top-right exit. That drew its focus ring and popped its "End voice
        // session" tooltip over a room the user had only just opened, so the
        // first thing the room said was how to leave it. Focus goes to the
        // sheet itself instead (Radix gives the content `tabIndex={-1}`), which
        // still announces the room and leaves Escape to the window handler
        // above.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.focus();
          }
        }}
        style={{ "--voice-sheet-top": `${headerBottom}px` } as CSSProperties}
        aria-label="Voice session"
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
  // the assistant is talking while it's actually silent (JARVIS-1279). Shared
  // with the iOS Live Activity mirror, which shows this exact string.
  const stateLabel = liveVoiceSurfaceLabel(
    state,
    reconnecting,
    assistantAudioActive,
  );

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

  // Resolve the assistant's look: color-with-eyes for character avatars, the
  // ambient void otherwise. The accent var is still published for the
  // fallback look's listening waves (null for custom-image / "none" /
  // still-loading avatars, where the waves keep their aurora fallback) — the
  // same derivation the iOS Live Activity mirrors, so island and room agree.
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);
  const look = resolveVoiceRoomLook(components, traits, customImageUrl);
  const tone = look ? toneForBg(look.bgHex) : null;
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
      if (event.key === "Escape") {
        event.preventDefault();
        minimizeVoiceRoom();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const fullscreen = variant === "fullscreen";

  const body = (
    <motion.div
      ref={roomRef}
      className={cn(
        "z-50 flex items-center justify-center overflow-hidden",
        // Every variant sits at z-50, the highest tier used inside the chat
        // layout. `overflow-hidden` above is what clips the full-bleed
        // color/wave layers to whatever radius the variant carries: the panel's
        // corners on desktop, the sheet's top corners on mobile.
        fullscreen && "fixed inset-0",
        variant === "content" && "absolute inset-0 rounded-xl",
        // The sheet's own box is the Radix content element, which is already
        // positioned and rounded; the room fills it.
        sheet && "absolute inset-0 rounded-t-[24px]",
      )}
      // Theme tokens (the connect label, the ambient transcript) follow the
      // look: dark over the void and the dark avatar colors, light over the
      // light one (yellow).
      data-theme={tone?.isLight ? "light" : "dark"}
      // The sheet's Radix content element is the dialog; a second `role` and
      // label nested inside it would announce the room twice.
      role={sheet ? undefined : "dialog"}
      // Only the fullscreen room is modal by its own declaration. The content
      // variant deliberately leaves the header and sidenav usable, so claiming
      // the rest of the app is inert would be a lie to assistive tech; the
      // sheet gets real modality from Radix instead of asserting it here.
      aria-modal={fullscreen || undefined}
      aria-label={sheet ? undefined : "Voice session"}
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
        ...toneVars,
        ...(accentHex ? { [AVATAR_ACCENT_CSS_VAR]: accentHex } : {}),
      }}
      // On close the chrome and rectangular backgrounds fade, while the avatar
      // shape itself shrinks back toward the entry origin — the color look's
      // body + eyes and the void look's centered avatar each own that exit — so
      // the room collapses into the avatar, not a shrinking rectangle. Under
      // the sheet none of that applies: the chrome slides the whole room out in
      // one piece, and this box holds still.
      {...choreography.shell}
    >
      {/* The color look (body grow entrance + color fade + centered waves +
          centered eyes) is the entire cast; the void look expresses the
          session through the centered avatar, but shares the color look's
          foreground chrome — the listening waves sweep in from the same top edge
          and the same state caption names the beat below the centerpiece — so
          the room reads identically for a custom avatar bar the full-screen
          color + eyes. Both draw the waves only while `listening`, from live mic
          amplitude. */}
      {look ? (
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
      ) : (
        <>
          <VoiceRoomAmbientBackground />
          {visual === "listening" ? (
            <VoiceMeshWaves
              getAmplitude={getLiveVoiceInputAmplitude}
              palette="accent"
              // Same top edge as the color look, above the centered avatar —
              // positional parity, only the aurora/accent color differs from the
              // color look's avatar-toned band.
              placement="top"
            />
          ) : null}
          {/* Responding: the same concentric rings the color look radiates from
              behind the eyes, here behind the centered avatar (both centered, so
              they emanate from the centerpiece the same way). Rendered before the
              avatar so it paints them behind it; rides the TTS-output amplitude. */}
          {visual === "responding" && box ? (
            <VoiceRespondingRings
              getAmplitude={getLiveVoiceOutputAmplitude}
              viewport={box}
            />
          ) : null}
          {/* Same state caption + gating as the color look (stands down while
              the assistant transcript is on), in the same shared lower zone —
              both looks name the beat from one baseline. */}
          {!showAssistantTranscript ? (
            <VoiceStateCaption visual={visual} />
          ) : null}
        </>
      )}

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

      {/* Top-right: the exit, alone. ✕ is never gated behind avatar readiness,
          so ending works even mid-load / on failure.
          Nothing else shares the corner. Minimize moved into the centred row
          below as "show transcript", named for what the user wants rather than
          for what the window does, and the in-session settings gear was deleted
          with it: a corner of small controls competed with the room's own cast
          for attention. Voice and listening language are Settings' now. */}
      <div
        // An equal gap from both edges, so the control reads as sitting in the
        // corner rather than floating near it.
        //
        // Only the fullscreen variant reaches the notch / Dynamic Island and
        // has to clear it. The panel and the sheet both start below the app's
        // own chrome, so clamping their top to the notch inset would push the
        // control a further ~59px down on a notched phone while the right stays
        // at the base gap: visibly lopsided, and measured against an edge the
        // room does not have.
        style={{
          top: fullscreen ? `max(${CORNER_GAP}, ${SAFE_AREA_TOP})` : CORNER_GAP,
          right: `max(${CORNER_GAP}, ${SAFE_AREA_RIGHT})`,
        }}
        className="absolute z-10 flex items-center gap-1"
      >
        <Tooltip content="End voice session">
          <button
            type="button"
            onClick={endLiveVoiceSession}
            aria-label="Exit voice session"
            className={ROOM_CONTROL_CLASS}
          >
            <X className="size-5" />
          </button>
        </Tooltip>
      </div>

      {/* Void look: the avatar springs to center once on entry (the wrapper
          owns the one-time entry spring); per-state expression is the avatar's
          own CSS loop, which cross-fades in place without re-popping. The
          color look has no centered figure — the bottom eyes are the cast. */}
      {!look ? (
        <motion.div
          className="relative z-0"
          {...voidAvatarMotion(choreography.entrance)}
        >
          <VoiceAvatar
            assistantId={assistantId}
            visual={visual}
            // Only the `responding` avatar is audio-reactive, and it always
            // rides TTS output — so the output amplitude is the sole source
            // here. The user's voice is expressed by the bottom waves in
            // `listening`, not by the avatar.
            getAmplitude={getLiveVoiceOutputAmplitude}
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
          - show the transcript, which minimizes the room to reveal the
            conversation underneath. The session keeps running on the
            composer's voice bar; this is the same move the old − made, named
            for what the user wants rather than what the window does.

          All three are persistent toggles, so the row never changes shape
          mid-call and a control never moves out from under a reaching finger.
          The two mutes are deliberately a symmetric pair: one per direction of
          the conversation, reading left to right as you and then it. */}
      <div
        data-testid="voice-room-controls"
        className="absolute inset-x-0 z-10 flex items-center justify-center gap-4"
        // The bottom edge IS the screen's on the sheet and fullscreen, so the
        // home-indicator inset is real here in a way the top inset was not.
        style={{ bottom: `max(${CORNER_GAP}, ${SAFE_AREA_BOTTOM})` }}
      >
        <Tooltip content={muted ? "Unmute microphone" : "Mute microphone"}>
          <button
            type="button"
            onClick={() => setLiveVoiceMuted(!muted)}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={muted}
            className={cn(
              SESSION_CONTROL_CLASS,
              muted
                ? tone?.isLight
                  ? "border-red-700/50 bg-red-600/15 text-red-800 hover:bg-red-600/25"
                  : "border-red-400/50 bg-red-500/20 text-red-300 hover:bg-red-500/30"
                : SESSION_CONTROL_NEUTRAL_CLASS,
            )}
          >
            {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </button>
        </Tooltip>

        <Tooltip content={outputMuted ? "Unmute assistant" : "Mute assistant"}>
          <button
            type="button"
            onClick={() => setLiveVoiceOutputMuted(!outputMuted)}
            aria-label={outputMuted ? "Unmute assistant" : "Mute assistant"}
            aria-pressed={outputMuted}
            className={cn(
              SESSION_CONTROL_CLASS,
              outputMuted
                ? tone?.isLight
                  ? "border-red-700/50 bg-red-600/15 text-red-800 hover:bg-red-600/25"
                  : "border-red-400/50 bg-red-500/20 text-red-300 hover:bg-red-500/30"
                : SESSION_CONTROL_NEUTRAL_CLASS,
            )}
          >
            {outputMuted ? (
              <VolumeX className="size-5" />
            ) : (
              <Volume2 className="size-5" />
            )}
          </button>
        </Tooltip>

        <Tooltip content="Show transcript (session keeps going)">
          <button
            type="button"
            onClick={minimizeVoiceRoom}
            aria-label="Show transcript"
            className={cn(SESSION_CONTROL_CLASS, SESSION_CONTROL_NEUTRAL_CLASS)}
          >
            <Captions className="size-5" />
          </button>
        </Tooltip>
      </div>

      {/* Screen readers get session-state changes here; the avatar is the
          visual channel, so this stays off-screen. */}
      <div aria-live="polite" className="sr-only">
        {muted ? `Muted — ${stateLabel}` : stateLabel}
      </div>
    </motion.div>
  );

  return sheet && choreography.sheetChrome ? (
    <VoiceRoomSheet
      headerBottom={headerBottom}
      motionProps={choreography.sheetChrome}
    >
      {body}
    </VoiceRoomSheet>
  ) : (
    body
  );
}
