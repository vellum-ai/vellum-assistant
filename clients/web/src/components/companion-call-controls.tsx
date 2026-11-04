import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Eraser,
  Eye,
  EyeOff,
  Mic,
  MicOff,
  Pencil,
  ScreenShare,
  Slash,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { createContext, useContext } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";

import type {
  CompanionAnnotationTool,
  CompanionPicker,
  VoiceActivityControlAction,
  VoiceActivityState,
  VoiceActivityWork,
} from "@vellumai/ipc-contract";

import {
  CompanionCallWorkSettled,
  CompanionCallWorkSpinner,
  callWorkAccent,
  runningCallWork,
  waitingCallWork,
} from "@/components/companion-call-work";
import { useTranslation } from "@/i18n";

/**
 * Where a control's caption stands: over the control, or beside it.
 *
 * Above is the shape the row is designed around, the way the Dock names an
 * icon under the pointer. A column has no room above a control that is not
 * its neighbour's, so its captions stand off to the side, toward the middle
 * of the screen, where there is a whole display to say the word in.
 */
type CaptionSide = "above" | "left" | "right";

/**
 * Which way the captions go, for every control in the call's bar at once.
 *
 * A context rather than a prop on each control, because it is a fact about
 * the bar: it is a row or a column, and every caption on it stands the same
 * way. Threading it through six controls to reach the one component that
 * draws a caption would be six places for one of them to be missed. Provided
 * around the call's body alone, since no other pill ever stands up.
 */
export const CaptionSideContext = createContext<CaptionSide>("above");

/**
 * The width of the call's status line: what the session is doing, and where
 * the turn says more than its phase does, what it is doing it to.
 *
 * Stated for the reason the transcript's is. The line is passed through from
 * the session, so it changes several times a call ("Listening…" to
 * "Thinking…" to "Reading a file"), and a box as wide as its content
 * would hand the pill a different width for each of them: the bar would
 * breathe in and out under the user's hand while the controls on it slid
 * sideways, on a surface that floats over another app's work. So the line has
 * one width whatever is in it, the pill takes its call width once, and a line
 * longer than the box is truncated rather than bought room for.
 *
 * Wide enough for the phase copy in the languages the app ships, with room for
 * the short activity lines a turn adds; anything past that is a line long
 * enough that its first words are the ones worth reading.
 */
export const CALL_LINE_WIDTH = 120;

/**
 * The background-work indicator's fixed width. When it appears, the status
 * line yields this much room so the call pill and its controls stay put.
 */
const CALL_WORK_CHIP_WIDTH = 32;

/**
 * The controls at the end of the call row, together: five buttons of a
 * 16-point glyph in 8 points of padding either side, the gap between each
 * pair, and the gap between the line and the first of them.
 *
 * Only used to state the call's fallback below, which is exact rather than a
 * guess now that the line beside them has a width of its own.
 */
export const CALL_CONTROLS_WIDTH = 5 * 32 + 5 * 4;

/**
 * How far the activity line runs down a column, in the units the layout is
 * authored in.
 *
 * One length whatever the session is saying, for the reason
 * {@link CALL_LINE_WIDTH} is one width: a column whose words came and went
 * would move every control under them on each phase. Shorter than the row's,
 * since the row spends its width on a line beside five controls and a column
 * spends its length on one above them, and a longer line would be an empty
 * stretch above the controls for most of what the session says.
 */
const CALL_COLUMN_LINE_LENGTH = 84;

/**
 * What a column is drawn at until its body has been measured: one control
 * wide, and the line's length and the five controls of the handlebar tall,
 * with the gaps between them.
 */
export const FALLBACK_COLUMN = {
  width: 28,
  height: CALL_COLUMN_LINE_LENGTH + 5 * 28 + 5 * 4,
};

/**
 * The keys that make the call row's presses from anywhere on the desktop, as
 * the caption spells them (`⌥S`). One per control that has a key; the row's
 * other controls have none and are named alone.
 */
export interface CompanionCallShortcuts {
  share: string;
  draw: string;
  muteMicrophone: string;
  muteAssistant: string;
}

/**
 * A control drawn as though the pointer were on it, for the beat of the
 * introduction that is about it: the name and the key are revealed with no
 * hover and no dwell.
 *
 * `talk` is the creature itself, which is the call button and carries its name
 * above it; the rest are controls on the call's bar.
 */
export type CompanionSurfaceSpotlight = "talk" | "share" | "draw" | "mute";

/**
 * The name's fill, named once and shared by the rectangle and its beak.
 *
 * A shared constant rather than the same literal typed twice. Translucent
 * rather than the flat fill this had before `backdrop-filter` was added:
 * the blur only has something to show once the fill lets it through. The
 * beak sits flush against the rectangle's bottom edge rather than
 * overlapping it (`top-full`, not a negative offset), so the two panes of
 * blurred backdrop meet edge to edge instead of compositing on top of each
 * other, which is what kept the flat-fill version seam-free and keeps this
 * one seam-free too.
 */
const NAME_CAPTION_FILL = "rgba(28, 28, 30, 0.55)";

/**
 * The blur and saturation boost shared by the rectangle and its beak, so the
 * one pane of "glass" reads as one material rather than two.
 *
 * An approximation of macOS's own vibrancy material, not the real thing: a
 * genuine `NSGlassEffectView` is a native layer, and this is HTML painted
 * inside the window's own transparent content, so the closest available
 * tool is Chromium's `backdrop-filter` sampling the desktop showing through
 * that transparency.
 */
const NAME_CAPTION_GLASS = "backdrop-blur-md backdrop-saturate-150";

/**
 * The lift that puts the caption's beak on the creature's edge rather than
 * short of it, in those same units.
 *
 * Flat rather than scaled: it closes the seam between the beak and what it
 * points at, and a seam is the same few pixels at every size of creature.
 */
export const NAME_CAPTION_LIFT = 4;

/**
 * A name for a thing under the pointer, the way the Dock names an icon: a
 * small rectangle above it with a beak pointing down at it. The creature's
 * name for a press, and each pill control's name for the pointer on it.
 *
 * Text only, no icon: what sits beneath it is the icon already, and the
 * Dock's own tooltip carries nothing but the name. A small rectangle rather
 * than the pill's stadium shape, so the two never share a silhouette.
 *
 * `shortcut` is the key that does the same thing, after the name and dimmer
 * than it, the way a menu writes its accelerator: the name is what the control
 * is, the key is a second way to it. Glyphs rather than copy, so it is not
 * translated.
 *
 * Placed by the caller: `className` carries whether it is shown and any lift
 * off the thing it names, `style` any offsets the layout works out. Absolute
 * with no offsets of its own, so a caller that sets none gets the static
 * position, which is what the pill's controls rely on.
 *
 * `aria-hidden` throughout: whatever it names carries the same word as its
 * accessible name, and a reader told it twice is told about two things.
 */
export function Caption({
  className,
  style,
  label,
  shortcut,
  beak = "down",
  ...data
}: {
  className: string;
  style?: CSSProperties;
  label: string;
  shortcut?: string;
  /**
   * Which way the beak points, which is toward whatever the caption names:
   * down from a caption standing over it, sideways from one standing beside.
   */
  beak?: "down" | "left" | "right";
} & Partial<Record<`data-${string}`, string>>) {
  return (
    <span
      className={`pointer-events-none absolute rounded-md px-2 py-1 text-[11px] leading-4 font-medium whitespace-nowrap text-white/90 shadow-md shadow-black/30 transition-opacity duration-200 ${NAME_CAPTION_GLASS} ${className}`}
      style={{ ...style, backgroundColor: NAME_CAPTION_FILL }}
      aria-hidden
      {...data}
    >
      {label}
      {shortcut === undefined ? null : (
        <span className="ml-1.5 font-normal text-white/60" data-shortcut>
          {shortcut}
        </span>
      )}
      {/* Flush with the rectangle's own bottom edge (`top-full`) rather than
          nudged down to meet it, so the two blurred panes meet at a seam
          rather than compositing on top of each other. Centred under the
          text rather than under the whole padded box for the same reason a
          Dock label's beak centres on the name: it is pointing at the icon
          below, and the icon is what the horizontal centre of this box was
          already placed over.

          Clipped to a triangle rather than drawn with the border trick:
          `backdrop-filter` blurs an element's whole border box, transparent
          border colour or not, so the border trick left a hazy rectangular
          smudge around the visible point. `clip-path` removes those corners
          from the element entirely, so there is nothing left there for the
          blur to show through. */}
      <span
        className={`absolute ${
          beak === "down"
            ? "top-full left-1/2 h-1.5 w-2.5 -translate-x-1/2"
            : beak === "left"
              ? "top-1/2 right-full h-2.5 w-1.5 -translate-y-1/2"
              : "top-1/2 left-full h-2.5 w-1.5 -translate-y-1/2"
        } ${NAME_CAPTION_GLASS}`}
        style={{
          backgroundColor: NAME_CAPTION_FILL,
          clipPath:
            beak === "down"
              ? "polygon(0 0, 100% 0, 50% 100%)"
              : beak === "left"
                ? "polygon(100% 0, 100% 100%, 0 50%)"
                : "polygon(0 0, 0 100%, 100% 50%)",
        }}
        aria-hidden
      />
    </span>
  );
}

/**
 * The way into a watch session and the way out of it, on the call row.
 *
 * One control for both edges, held down for as long as the session runs, so
 * the row says which press ends it. `pressed` because this one is a state and
 * not a look: a reader is told a session is running, where everything else
 * this surface does about it is a colour they never receive.
 *
 * Absent entirely when Watch is not offered, rather than disabled: a user who
 * cannot have the feature is not owed a control that explains itself by
 * refusing them. The pill measures its own contents, so the row simply comes
 * out narrower.
 *
 * **The exit outlives the door.** A session running under a flag that has
 * since been turned off still reads the screen, so the row that would have
 * carried Teach carries the stop instead, the same stop the idle row draws.
 * Hiding the way in is the whole of what the flag does; leaving a capture
 * with nothing that ends it is not something a flag is allowed to cause.
 *
 * **The way in may be a question first.** Where the page can ask what to
 * read, the press with no session running opens its picker rather than a
 * session, and Teach is drawn held down for the asking; the pick is what
 * starts the session. The stop is never a question.
 */
function TeachButton({
  watching,
  watchEnabled,
  picking,
  dimmed,
  onWatch,
  onTeach,
}: {
  watching: boolean;
  watchEnabled: boolean;
  picking: boolean;
  dimmed?: boolean;
  onWatch?: () => void;
  onTeach?: () => void;
}) {
  const { t } = useTranslation();
  if (!watchEnabled) {
    return watching ? <StopWatchingButton onWatch={onWatch} /> : null;
  }
  return (
    <PillButton
      icon={<Eye className="size-4" />}
      label={t("companionSurface.teach")}
      dimmed={dimmed}
      // Held down for the session and for the choice before it alike: both
      // are states this press is in the middle of, and the second press ends
      // either one.
      pressed={watching || picking}
      // The stop is the session's whatever the page wants of a start. A page
      // with no picker leaves `onTeach` unset and both edges take `onWatch`,
      // which is the toggle it always was.
      onClick={watching ? onWatch : (onTeach ?? onWatch)}
    />
  );
}

/**
 * Expanded, mid-call: what the session is doing, and the controls that act on
 * it.
 *
 * **This is the desktop's whole live-voice surface**, so it carries what the
 * iOS Lock Screen card carries: the phase as a glyph and as the session's own
 * wording, elapsed time, and the session's controls. It has one line where that
 * card has several, which is what the choices below are about.
 *
 * **No phase copy of its own.** Every word here is `label` or `detail`, passed
 * through from the session's store, because the phase wording deploys
 * continuously with the web bundle while this surface's shell ships on release
 * cadence. A surface that re-words its own phases is how the two come to
 * disagree.
 *
 * **And no phase glyph.** One belonged here until it collided: a microphone
 * meaning "listening" sat forty pixels from a microphone meaning "mute", and a
 * speaker meaning "speaking" from a speaker meaning "mute the assistant".
 * Adjacent identical glyphs meaning different things is a coin flip, so status
 * moved to the mascot, which is the one element on the pill that is not a
 * control and cannot be mistaken for one.
 */
export function CallBody({
  call,
  assistantName,
  spotlight,
  watching,
  watchEnabled,
  picking,
  sharing,
  shareEnabled,
  sharePicking,
  annotating,
  marked,
  annotationTool,
  vertical,
  drawToolsPlacement,
  drawToolsRef,
  onAnnotationTool,
  onControl,
  onWatch,
  onTeach,
  onShare,
  onStopShare,
  onAnnotate,
  onClearMarks,
  openPicker,
  onPicker,
  pickerSide,
  shortcuts,
  promptsDeferred = 0,
  onReviewPrompts,
  lineExtra = 0,
  accentHex,
  workShelfOpen,
  onToggleWorkShelf,
}: {
  call?: VoiceActivityState;
  assistantName: string;
  watching: boolean;
  watchEnabled: boolean;
  picking: boolean;
  sharing: boolean;
  shareEnabled: boolean;
  sharePicking: boolean;
  annotating: boolean;
  marked: boolean;
  annotationTool?: CompanionAnnotationTool;
  /**
   * Whether the bar is a column. The words the row carries in its line do
   * not fit across a column, so they stand beside it instead, as a label of
   * the kind the controls' captions are, and up for as long as the bar is.
   */
  vertical: boolean;
  drawToolsPlacement: DrawToolsPlacement;
  drawToolsRef?: Ref<HTMLDivElement>;
  onAnnotationTool?: (tool: CompanionAnnotationTool) => void;
  onControl?: (action: VoiceActivityControlAction, requestId?: string) => void;
  onWatch?: () => void;
  onTeach?: () => void;
  onShare?: () => void;
  onStopShare?: () => void;
  onAnnotate?: (annotating: boolean) => void;
  onClearMarks?: () => void;
  openPicker?: CompanionPicker;
  onPicker?: (picker: CompanionPicker) => void;
  /** Where the popover a chevron opens hangs from the bar, which it points at. */
  pickerSide: DrawToolsPlacement;
  shortcuts?: CompanionCallShortcuts;
  spotlight?: CompanionSurfaceSpotlight;
  promptsDeferred?: number;
  onReviewPrompts?: () => void;
  /** Width past its own the line takes, to fill a bar a prompt widened. */
  lineExtra?: number;
  accentHex: string;
  workShelfOpen: boolean;
  /** Absent where the bar cannot carry the list, which leaves the count. */
  onToggleWorkShelf?: () => void;
}) {
  const { t } = useTranslation();
  // The dial: Talk has been pressed and no session has answered. The mutes
  // have nothing to act on yet and a press on them would be dropped, so the
  // row is who is being called and the one control that means something, the
  // end, which is the user changing their mind. Teach stays where it is, so a
  // session already reading the screen does not lose its stop for the beat.
  if (call === undefined) {
    return (
      <>
        <CallLine
          vertical={vertical}
          extra={lineExtra}
          text={
            assistantName === ""
              ? t("companionSurface.calling")
              : t("companionSurface.callingNamed", { name: assistantName })
          }
        />
        <TeachButton
          watching={watching}
          watchEnabled={watchEnabled}
          picking={picking}
          onWatch={onWatch}
          onTeach={onTeach}
        />
        <EndCallButton onControl={onControl} />
      </>
    );
  }
  // The phase, and the turn's own step when the session has no work list to
  // carry it. A session that sends `work` names the step there, on the
  // foreground's line, and the phase reads "Working…" for it; one that
  // predates the list has only this line, and the step is the more specific
  // of the two ("Reading a file" against "Thinking…").
  const line = call.work === undefined ? call.detail || call.label : call.label;
  const work = call.work ?? [];
  const hasWork = work.length > 0;
  const { muted, outputMuted } = call;
  // Who is on this call, which is not always who the app is showing. A
  // session outlives a switch to another assistant, while `assistantName` on
  // the surface follows the selection, so a control named from the selection
  // would offer to mute an assistant that is not on the call. The session's
  // own name is fixed for its lifetime (see `VoiceActivityStart`), which is
  // exactly the owner these controls act on. The dial above has no session
  // and so has only the selection, which is the assistant it just rang.
  const onCall = call.assistantName;

  return (
    <>
      {hasWork ? (
        <WorkChip
          work={work}
          accentHex={accentHex}
          open={workShelfOpen}
          onToggle={onToggleWorkShelf}
        />
      ) : null}
      {/* One width, whatever the session is saying. See
          {@link CALL_LINE_WIDTH}. `shrink-0` because the pill measures this row
          to decide how wide to be, and a box that collapsed under pressure
          would measure its own collapsed self: the width and the truncation
          would chase each other down. */}
      <CallLine
        vertical={vertical}
        extra={lineExtra - (!vertical && hasWork ? CALL_WORK_CHIP_WIDTH : 0)}
        text={line}
      />
      {/* What was put off, beside what the session is doing: it is the
          assistant waiting on the user, which is part of what the call is
          doing. A press lists it again. */}
      {promptsDeferred > 0 ? (
        <button
          type="button"
          // Drawn with the design-library's negative tokens, which resolve
          // against dark here as they do on the dark bar around them.
          data-theme="dark"
          aria-label={t("companionPopover.pendingBadge", {
            count: promptsDeferred,
          })}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--system-negative-weak)] text-[13px] text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-hover)] hover:text-white"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={() => {
            onReviewPrompts?.();
          }}
        >
          {promptsDeferred}
        </button>
      ) : null}
      {/* Beside what the session is doing rather than beside the end control:
          two stops next to each other is a misclick that ends the wrong thing,
          and only one of the two is irreversible. Teach rides the call rather
          than being refused by it: a screen read while talking is a question
          the assistant can answer as it is asked. */}
      <TeachButton
        watching={watching}
        watchEnabled={watchEnabled}
        picking={picking}
        dimmed={spotlight !== undefined}
        onWatch={onWatch}
        onTeach={onTeach}
      />
      {/* Beside Teach, since the two are the same gesture aimed at different
          ends: Teach has the screen read for a lesson, Share has it shown to
          the call. Not on the dial, where there is no session to show. */}
      <ShareButton
        sharing={sharing}
        shareEnabled={shareEnabled}
        sharePicking={sharePicking}
        shortcut={shareEnabled ? shortcuts?.share : undefined}
        spotlit={spotlight === "share"}
        dimmed={spotlight !== undefined && spotlight !== "share"}
        onShare={onShare}
        onStopShare={onStopShare}
      />
      {/* Behind Share and only while one is running, because it acts on what
          is being shared: there is nothing to draw on until there is. */}
      <DrawButton
        sharing={sharing}
        annotating={annotating}
        spotlit={spotlight === "draw"}
        dimmed={spotlight !== undefined && spotlight !== "draw"}
        shortcut={shareEnabled ? shortcuts?.draw : undefined}
        tool={annotationTool}
        placement={drawToolsPlacement}
        toolsRef={drawToolsRef}
        onAnnotate={onAnnotate}
        onTool={onAnnotationTool}
      />
      {/* Behind Draw and only while something is on the shared surface,
          because that is what it acts on: the marks come down and the share
          goes on. */}
      <ClearButton
        sharing={sharing}
        marked={marked}
        dimmed={spotlight !== undefined}
        onClearMarks={onClearMarks}
      />
      <PillButton
        icon={
          outputMuted ? (
            <VolumeX className="size-4" />
          ) : (
            <Volume2 className="size-4" />
          )
        }
        // The speaker silences whoever is on the call, so it is named the way
        // the dial names them and the row reads as one conversation rather
        // than as a device panel. Unnamed until a name arrives, since a label
        // built around an empty one reads as a bug.
        label={
          onCall === ""
            ? outputMuted
              ? t("companionSurface.unmuteAssistant")
              : t("companionSurface.muteAssistant")
            : outputMuted
              ? t("companionSurface.unmuteAssistantNamed", { name: onCall })
              : t("companionSurface.muteAssistantNamed", { name: onCall })
        }
        shortcut={shortcuts?.muteAssistant}
        // The mute beat is about both directions, so both controls are lit:
        // the sentence says "either of us" and a row that lit one of them
        // would be pointing at half of it.
        spotlit={spotlight === "mute"}
        dimmed={spotlight !== undefined && spotlight !== "mute"}
        onClick={() => {
          onControl?.(
            outputMuted ? "unmuteAssistantAudio" : "muteAssistantAudio",
          );
        }}
      />
      <PillButton
        icon={
          muted ? <MicOff className="size-4" /> : <Mic className="size-4" />
        }
        label={
          muted
            ? t("companionSurface.unmuteMicrophone")
            : t("companionSurface.muteMicrophone")
        }
        shortcut={shortcuts?.muteMicrophone}
        control="mute"
        spotlit={spotlight === "mute"}
        dimmed={spotlight !== undefined && spotlight !== "mute"}
        onClick={() => {
          onControl?.(muted ? "unmuteMicrophone" : "muteMicrophone");
        }}
      />
      {/* Beside the control it chooses for, the way a system call bar puts
          the device menu next to its mute. */}
      <PickerChevron
        picker="microphones"
        label={t("companionSurface.chooseMicrophone")}
        side={pickerSide}
        open={openPicker === "microphones"}
        onPicker={onPicker}
      />
      <EndCallButton dimmed={spotlight !== undefined} onControl={onControl} />
    </>
  );
}

/**
 * What the session is doing, in the bar.
 *
 * On a row it follows the background-work indicator when one is present, at
 * one width whatever it says (see {@link CALL_LINE_WIDTH}). On a column it
 * follows that indicator down the column and runs along it, the way a title
 * runs down a book's spine: the same words at one length of their own (see
 * {@link CALL_COLUMN_LINE_LENGTH}), turned to lie with the controls, so the
 * column stays one control wide. Written the other way, the line would be
 * the widest thing in the column by a long way and the whole bar would
 * widen to it. Top to bottom on either side, which is the way a spine reads.
 *
 * In the column rather than beside it, because it is what the bar is saying
 * and belongs in the bar; the captions that stand beside a column are the
 * controls' names, revealed by the pointer, and a line that stood with them
 * would read as one more of those.
 */
function CallLine({
  vertical,
  text,
  extra = 0,
}: {
  vertical: boolean;
  text: string;
  extra?: number;
}) {
  if (vertical) {
    return (
      <span
        className="mt-1 shrink-0 truncate text-[12px] text-white/85"
        style={{
          height: CALL_COLUMN_LINE_LENGTH + extra,
          writingMode: "vertical-rl",
        }}
        data-label="line"
      >
        {text}
      </span>
    );
  }
  return (
    <span
      className="ml-1 shrink-0 truncate text-[12px] text-white/85"
      style={{ width: CALL_LINE_WIDTH + extra }}
      data-label="line"
    >
      {text}
    </span>
  );
}

/**
 * Show the call the screen, or stop, on the call row beside Teach.
 *
 * The same shape as {@link TeachButton}, edge for edge: absent entirely where
 * the call cannot be shown anything rather than disabled, held down for the
 * share and for the choice before it, and the stop is the press on the held
 * control and never a question. A share already running when the answer
 * turns negative keeps its stop, for the reason Teach's exit outlives its
 * door.
 *
 * One name for both edges, the way Teach has one: the held-down state and
 * `aria-pressed` say which press this is, and a control that renamed itself
 * to "Stop" would be a caption where the row wants an affordance.
 */
function ShareButton({
  sharing,
  shareEnabled,
  sharePicking,
  shortcut,
  spotlit,
  dimmed,
  onShare,
  onStopShare,
}: {
  sharing: boolean;
  shareEnabled: boolean;
  sharePicking: boolean;
  shortcut?: string;
  spotlit?: boolean;
  dimmed?: boolean;
  onShare?: () => void;
  onStopShare?: () => void;
}) {
  const { t } = useTranslation();
  if (!shareEnabled && !sharing) {
    return null;
  }
  return (
    <PillButton
      icon={<ScreenShare className="size-4" />}
      label={t("companionSurface.share")}
      shortcut={shortcut}
      control="share"
      spotlit={spotlit}
      dimmed={dimmed}
      pressed={sharing || sharePicking}
      onClick={sharing ? onStopShare : onShare}
    />
  );
}

/**
 * Draw on what the call is being shown, on the call row behind Share.
 *
 * Absent unless a share is running, rather than disabled: it acts on the
 * shared surface, and before there is one it is not a control that is
 * unavailable, it is a control with nothing to be about. The same reason
 * {@link ShareButton} is absent off a call.
 *
 * The one control on this row whose press changes what the *desktop* does
 * rather than what the session does: while it is held down the frame around
 * the shared surface takes the mouse, so a press out there is a mark instead
 * of a click on the app underneath. That is a big thing to do quietly, which
 * is why it is a mode with a control drawn held down for as long as it lasts
 * rather than something that happens on a modifier nobody can see.
 *
 * While the mode is on, the tools stand off this control in a strip of their
 * own ({@link DrawTools}). Off it rather than in the row, since the row is
 * one thin line of controls by design and the tools are a choice inside one
 * of them; and only while the mode is on, since a tool is a fact about the
 * next press on the frame, and off the mode there is no such press. Not at
 * all on a shell that names no tool: that shell cannot take the choice.
 */
function DrawButton({
  sharing,
  annotating,
  shortcut,
  spotlit,
  dimmed,
  tool,
  placement,
  toolsRef,
  onAnnotate,
  onTool,
}: {
  sharing: boolean;
  annotating: boolean;
  shortcut?: string;
  spotlit?: boolean;
  dimmed?: boolean;
  /** Absent on a shell with only the pencil, which draws no strip. */
  tool?: CompanionAnnotationTool;
  placement: DrawToolsPlacement;
  toolsRef?: Ref<HTMLDivElement>;
  onAnnotate?: (annotating: boolean) => void;
  onTool?: (tool: CompanionAnnotationTool) => void;
}) {
  const { t } = useTranslation();
  if (!sharing) {
    return null;
  }
  return (
    <>
      <PillButton
        icon={<Pencil className="size-4" />}
        label={t("companionSurface.draw")}
        shortcut={shortcut}
        control="draw"
        spotlit={spotlit}
        dimmed={dimmed}
        pressed={annotating}
        // The anchor the strip hangs off. See `.companion-draw-anchor`.
        className="companion-draw-anchor"
        onClick={() => {
          onAnnotate?.(!annotating);
        }}
      />
      {annotating && tool !== undefined && (
        <DrawTools
          tool={tool}
          placement={placement}
          toolsRef={toolsRef}
          onTool={onTool}
        />
      )}
    </>
  );
}

/**
 * Where the drawing tools stand off the Draw control: over or under a row,
 * beside a column.
 */
type DrawToolsPlacement = "above" | "below" | "left" | "right";

/**
 * The drawing tools, in a strip hung off the Draw control: the pencil, a
 * line, a box and a circle, the current one drawn held down.
 *
 * **On the card side of the pill.** The canvas keeps only its own pad on the
 * other side, which a strip standing there would be cut off by, so the strip
 * goes where the introduction's card and the picker go: above the pill where
 * the card grows up, below it where the card grows down. Beside a column,
 * toward the middle of the screen, where its captions go and for the same
 * reason. The stylesheet places it against the control by CSS anchor
 * positioning (`.companion-draw-tools`), so nothing here measures where in
 * the row the control ended up, and the row's own clipping cannot take it:
 * its containing block is the row's positioned parent, the same way the
 * captions escape.
 *
 * A press on the strip's own padding is stopped like a press on a control,
 * so the strip is not a drag handle for the surface: it is a menu, and a
 * menu that moved the pill when missed would move the thing it was hung off.
 */
function DrawTools({
  tool,
  placement,
  toolsRef,
  onTool,
}: {
  tool: CompanionAnnotationTool;
  placement: DrawToolsPlacement;
  toolsRef?: Ref<HTMLDivElement>;
  onTool?: (tool: CompanionAnnotationTool) => void;
}) {
  const { t } = useTranslation();
  const tools: readonly {
    tool: CompanionAnnotationTool;
    icon: ReactNode;
    label: string;
  }[] = [
    {
      tool: "freehand",
      icon: <Pencil className="size-4" />,
      label: t("companionSurface.drawFreehand"),
    },
    {
      tool: "line",
      icon: <Slash className="size-4" />,
      label: t("companionSurface.drawLine"),
    },
    {
      tool: "box",
      icon: <Square className="size-4" />,
      label: t("companionSurface.drawBox"),
    },
    {
      tool: "circle",
      icon: <Circle className="size-4" />,
      label: t("companionSurface.drawCircle"),
    },
  ];
  return (
    <div
      className={`companion-draw-tools absolute flex items-center gap-0.5 rounded-full border border-white/10 bg-[#17181b]/95 p-0.5 shadow-lg shadow-black/40 companion-draw-tools-${placement} ${
        placement === "left" || placement === "right" ? "flex-col" : ""
      }`}
      role="group"
      aria-label={t("companionSurface.drawTools")}
      data-testid="companion-draw-tools"
      ref={toolsRef}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {tools.map((one) => (
        <PillButton
          key={one.tool}
          icon={one.icon}
          label={one.label}
          pressed={tool === one.tool}
          onClick={() => {
            onTool?.(one.tool);
          }}
        />
      ))}
    </div>
  );
}

/**
 * Take down everything on the shared surface: the assistant's marks, and
 * the user's own ink. Beside Draw, since both act on the same surface.
 *
 * Absent unless something is up, for the reason {@link DrawButton} is absent
 * off a share: a control with nothing to be about. What counts as something
 * up is the host's to say, since the marks are on a window this surface
 * cannot see.
 *
 * Not the end of anything. The share goes on, the mode stays where it was,
 * and the assistant's next mark lands on a clean surface: this is how a mark
 * comes down without ending the share it was about.
 */
function ClearButton({
  sharing,
  marked,
  dimmed,
  onClearMarks,
}: {
  sharing: boolean;
  marked: boolean;
  dimmed?: boolean;
  onClearMarks?: () => void;
}) {
  const { t } = useTranslation();
  if (!sharing || !marked) {
    return null;
  }
  return (
    <PillButton
      icon={<Eraser className="size-4" />}
      label={t("companionSurface.clearMarks")}
      dimmed={dimmed}
      onClick={() => {
        onClearMarks?.();
      }}
    />
  );
}

/**
 * The room's own end control, at pill scale: the same glyph at the same weight
 * in the same destructive tone. Ending a call is the one irreversible thing on
 * this surface, so it looks identical wherever the user meets it, the dial
 * included: there it is the press that takes the request back.
 */
function EndCallButton({
  dimmed,
  onControl,
}: {
  dimmed?: boolean;
  onControl?: (action: VoiceActivityControlAction, requestId?: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <PillButton
      icon={<X className="size-4" strokeWidth={2.5} />}
      label={t("companionSurface.endSession")}
      tone="negative"
      dimmed={dimmed}
      onClick={() => {
        onControl?.("endSession");
      }}
    />
  );
}

/**
 * End the watch session, on whichever row the user is looking at.
 *
 * One component for the rows that draw it, because the label is the whole of
 * what this control says. It carries no words, so an accessible name that
 * drifted between the idle row and the call row would be two different controls
 * to anyone reading the surface rather than looking at it, and this is the
 * control a user reaches for precisely when they want the reading to stop.
 *
 * An action rather than a toggle, and so no pressed state: it goes one way, and
 * it is drawn only while there is a session for it to end. Its name is what
 * tells a reader both of those things at once, since a control offering to stop
 * the watching is only there when something is being watched.
 */
export function StopWatchingButton({ onWatch }: { onWatch?: () => void }) {
  const { t } = useTranslation();
  return (
    <PillButton
      icon={<EyeOff className="size-4" />}
      label={t("companionSurface.stopTeaching")}
      onClick={onWatch}
    />
  );
}

/**
 * Where a control's caption sits: standing on the pill's top edge, with only
 * its beak crossing into the pill to point at the control below.
 *
 * The caption starts out centred on the control (see {@link PillButton}), so
 * the lift is its own half height, which puts its bottom edge on the control's
 * centre, plus half the pill's `h-11` row to carry that edge up to the row's
 * top. 22px is the one number the caption and the row share, and it holds at
 * every avatar size: the whole surface is drawn scaled, so both are in the
 * same units.
 *
 * Not further up. Growing downward the canvas keeps only its own pad above the
 * pill, which a caption standing here clears by around 7px, and one lifted
 * clear of the pill's edge would be cut off by the top of the window.
 */
const CONTROL_CAPTION_LIFT = "-translate-y-[calc(50%+22px)]";

/**
 * Where a control's caption sits on a column: standing off the column's edge,
 * with only its beak crossing into it to point at the control beside it.
 *
 * The same 22px, read across: the column is the row stood up, so its half
 * width is the row's half height, and the caption's own half width carries
 * its near edge to the column's edge the way its half height carries its
 * bottom edge to the row's top. Toward the middle of the screen, since a
 * column stands against a side of the display and the other way is off it.
 */
const CONTROL_CAPTION_BESIDE: Record<Exclude<CaptionSide, "above">, string> = {
  right: "translate-x-[calc(50%+22px)]",
  left: "-translate-x-[calc(50%+22px)]",
};

/** The way a caption stands off its control, by which side it stands on. */
const captionStance = (
  side: CaptionSide,
): { className: string; beak: "down" | "left" | "right" } =>
  side === "above"
    ? { className: CONTROL_CAPTION_LIFT, beak: "down" }
    : {
        className: CONTROL_CAPTION_BESIDE[side],
        beak: side === "right" ? "left" : "right",
      };

/**
 * The call's work on its row: a turning arc around how many pieces are
 * running, which settles to a mark for a beat when the last one finishes. A
 * press opens the list of them joined to the bar. Beside the line, since it is
 * part of what the call is doing.
 *
 * The caption names what is running rather than the press, the way a count
 * is read: the names are what the pointer came for.
 */
function WorkChip({
  work,
  accentHex,
  open,
  onToggle,
}: {
  work: readonly VoiceActivityWork[];
  accentHex: string;
  open: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const stance = captionStance(useContext(CaptionSideContext));
  const running = runningCallWork(work);
  const waiting = waitingCallWork(work);
  // What the count counts: the work moving, or failing that the work held on
  // the user, which is still open but not running.
  const counted = running.length > 0 ? running : waiting;
  const last = work.at(-1);
  const names = (counted.length > 0 ? counted : work)
    .map((item) => item.title)
    .join(" · ");
  return (
    <button
      type="button"
      aria-label={
        running.length === 0 && waiting.length > 0
          ? t("companionSurface.workWaiting", { count: waiting.length })
          : t("companionSurface.workCount", { count: running.length })
      }
      aria-expanded={onToggle === undefined ? undefined : open}
      data-control="work"
      disabled={onToggle === undefined}
      // The same 32 by 28 capsule as the call's other controls, a 16pt icon
      // in `px-2`, so its hover and open background is the same shape theirs is.
      className={`group flex h-7 shrink-0 items-center justify-center rounded-full px-1.5 transition-colors enabled:hover:bg-white/15 ${
        open ? "bg-white/15" : ""
      }`}
      style={{ ...callWorkAccent(accentHex), width: CALL_WORK_CHIP_WIDTH }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={onToggle}
    >
      <span className="relative grid size-5 place-items-center">
        {counted.length > 0 ? (
          <>
            <span className="absolute inset-0 grid place-items-center">
              <CompanionCallWorkSpinner
                size={20}
                still={running.length === 0}
              />
            </span>
            <span className="text-[10px] leading-none font-semibold text-white/90 tabular-nums">
              {counted.length}
            </span>
          </>
        ) : (
          <CompanionCallWorkSettled
            state={last?.state === "failed" ? "failed" : "done"}
          />
        )}
      </span>
      {open ? null : (
        <Caption
          label={names}
          className={`opacity-0 group-hover:opacity-100 ${stance.className}`}
          beak={stance.beak}
          data-label="hover"
        />
      )}
    </button>
  );
}

/**
 * A control in the pill.
 *
 * `label` is always the accessible name. It is drawn in the row only when the
 * pill has room for words (`showLabel`); everywhere else the control is an
 * icon with its name in a {@link Caption} above it, the way the Dock names an
 * icon under the pointer, so the call's controls are icon-only without being
 * unlabelled and the pill is one width whatever the pointer is doing.
 *
 * **The caption is `:hover`, deliberately, and this is the one place on the
 * surface where that is not a matter of taste.** The host's window is
 * click-through, so the page derives its own hover by hit-testing coordinates
 * against the pill on every forwarded mouse-move rather than trusting
 * `mouseenter` (`companion-surface-page.tsx`). A per-control reveal driven off
 * React's mouse events would be betting on the events that page does not
 * receive. The held-down background on this very button runs on `:hover`, so
 * a caption on the same mechanism works exactly where the rest of the control
 * does.
 *
 * **The caption escapes the row's clipping by having a different containing
 * block.** The row hides its overflow so nothing is drawn past the pill while
 * the width catches up with the content, and a caption standing above the row
 * is exactly that overflow. Overflow clips only what the clipping box
 * contains, so the caption is positioned against the row's parent instead:
 * this button is not positioned and neither is the row, and with no offsets
 * of its own the caption takes its static position, which for the child of a
 * flex container is where it would sit as the sole item. `justify-center` and
 * `items-center` put that on the control's centre, and from there the caption
 * lifts by {@link CONTROL_CAPTION_LIFT}. Nothing measures anything.
 *
 * `pressed` is the control's own on or off, which is a state: a button
 * reporting a state it does not have is one assistive technology describes
 * wrongly, so it is undefined for everything that does not toggle, which is
 * most of this surface. Where it is set it draws the held-down look as well,
 * so the state a looking user reads off the background and the state a reader
 * is told cannot come apart.
 */
const CHEVRON_FOR_SIDE: Record<DrawToolsPlacement, typeof ChevronUp> = {
  above: ChevronUp,
  below: ChevronDown,
  left: ChevronLeft,
  right: ChevronRight,
};

/**
 * A narrow chevron beside a call control that opens its picker in the
 * popover, pointing the way the popover opens. Held down while its picker is
 * the one showing; a second press closes it.
 */
function PickerChevron({
  picker,
  label,
  side,
  open,
  onPicker,
}: {
  picker: CompanionPicker;
  label: string;
  side: DrawToolsPlacement;
  open: boolean;
  onPicker?: (picker: CompanionPicker) => void;
}) {
  if (onPicker === undefined) {
    return null;
  }
  const Chevron = CHEVRON_FOR_SIDE[side];
  return (
    <PillButton
      icon={<Chevron className="size-3.5" strokeWidth={2.25} />}
      label={label}
      pressed={open}
      narrow
      onClick={() => {
        onPicker(picker);
      }}
    />
  );
}

export function PillButton({
  icon,
  label,
  shortcut,
  tone,
  showLabel = false,
  pressed,
  spotlit = false,
  dimmed = false,
  control,
  narrow = false,
  className = "",
  onClick,
}: {
  icon: ReactNode;
  label: string;
  /** The key that makes the same press, written into the caption after the name. */
  shortcut?: string;
  tone?: "positive" | "negative";
  showLabel?: boolean;
  pressed?: boolean;
  /**
   * Drawn as the control in use, for the beat of the introduction that is
   * about it: the same held-down look a press gives it, with no pointer on it.
   * See {@link CompanionSurfaceSpotlight}.
   */
  spotlit?: boolean;
  /**
   * Stood down, because the introduction is describing a different control.
   * Every other control on the row dims rather than staying at full strength,
   * so the one being described is the only live thing on the bar.
   */
  dimmed?: boolean;
  /**
   * Which control this is, in the introduction's vocabulary, written onto the
   * element as `data-control`. The introduction's card finds it there to aim
   * its beak at, which is a measurement rather than a layout the card could
   * derive: this row's controls come and go with the session's state.
   */
  control?: CompanionSurfaceSpotlight;
  /** Drawn to its icon's width, for a chevron riding beside another control. */
  narrow?: boolean;
  /** A name for the stylesheet, for a control something else is placed against. */
  className?: string;
  onClick?: () => void;
}) {
  const stance = captionStance(useContext(CaptionSideContext));
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-control={control}
      onClick={onClick}
      // A press on a control is not the start of a drag. Without this the
      // surface would move under a click meant to activate something on it.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      className={`group flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full text-[12px] transition-[background-color,opacity] duration-200 hover:bg-white/15 ${
        narrow ? "-mx-1 px-0.5" : "px-2"
      } ${className} ${
        pressed === true || spotlit ? "bg-white/15" : ""
      } ${dimmed ? "opacity-35" : ""} ${
        tone === "negative"
          ? "text-[#ff6b6b]"
          : tone === "positive"
            ? "text-[#5ee08a]"
            : "text-white/85"
      }`}
    >
      {icon}
      {showLabel ? (
        <span>{label}</span>
      ) : (
        // `data-label` is the caption's contract, and it is here because the
        // behaviour itself is a stylesheet: a test running without Tailwind
        // sees a span either way, so the attribute is the only honest way to
        // hold that this word is hidden until the pointer arrives.
        <Caption
          label={label}
          shortcut={shortcut}
          className={`opacity-0 group-hover:opacity-100 ${stance.className}`}
          beak={stance.beak}
          data-label="hover"
        />
      )}
    </button>
  );
}
