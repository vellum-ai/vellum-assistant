/**
 * UI-only research-result steps for the research-onboarding flow.
 *
 * SPIKE — research-onboarding flow.
 *
 * These render the visual sequence that follows the calendar step:
 *   - MeetingCreatedStep   a brief "Check-in scheduled…" confirmation
 *   - LookingYouUpStep     a loading carousel ("looking you up")
 *   - ResearchResultsStep  the editable "Alright, this is what I got:" claims
 *   - SuggestionsStep      tappable suggestions that open a new chat
 *
 * Foreground only (the toned backdrop sits behind). The claims + suggestions
 * are the REAL research output — the route fires the research turn against the
 * hatched assistant (see `research-runner.ts`) and threads the parsed
 * `{ claims, suggestions }` in here. Each step falls back to a graceful
 * loading / empty presentation while the turn is still streaming.
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import {
  toneForBg,
  useOnboardingTone,
  type OnboardingTone,
} from "@/domains/onboarding/onboarding-tone";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import {
  pluginDisplayName,
  type ResearchFact,
  type ResearchSuggestion,
} from "@/utils/research-facts";

// Once the calendar step blends the background to black, every step from there
// on sits on a constant dark surface — so their text/UI must be a constant
// light tone, NOT one derived from the chosen avatar color (a light avatar like
// yellow would otherwise render dark text, invisible on black). The avatar color
// is still used where it's intentional (e.g. the plugin pills).
const DARK_TONE = toneForBg("#17191C");

function useViewportSize() {
  const [size, setSize] = useState(() => ({
    w: typeof window === "undefined" ? 1280 : window.innerWidth,
    h: typeof window === "undefined" ? 800 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** The chosen avatar's components + traits. */
function useChosenAvatar() {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;
  return { components, chosen };
}

/** The chosen assistant as a live avatar (for the heading rows). */
export function MiniAssistant({
  size = 64,
  isStreaming = false,
}: {
  size?: number;
  /** Morph the body while active (e.g. during the looking-you-up carousel). */
  isStreaming?: boolean;
}) {
  const { components, chosen } = useChosenAvatar();
  if (!components || !chosen) return <div style={{ width: size, height: size }} />;
  return (
    <div className="shrink-0" style={{ width: size, height: size }}>
      <AnimatedAvatar
        components={components}
        traits={chosen}
        size={size}
        isStreaming={isStreaming}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meeting Created
// ---------------------------------------------------------------------------

// Matches the carousel/result steps' avatar size so the avatar doesn't jump
// between the meeting step and the looking-you-up step that follows it.
const MINI = 64;

// The confirmation animation runs ~1.3s to reveal the title; hold well past it
// so the booked time stays readable for ~3s before advancing.
const MEETING_MIN_MS = 4500;
// Cap how long we hold for a slow-but-pending booking before advancing anyway.
const MEETING_MAX_MS = 7000;

/**
 * Reverse of the Introduction grow-in. The toned backdrop (behind) blends to
 * black and hides its bottom eyes; here the eyes lead — shrinking and rising
 * up out of the bottom (the opposite of growing + sinking) — and the body
 * follows a beat later, shrinking into a small avatar beside the "Check-in
 * scheduled…" text. The edge characters stay (they live in the backdrop).
 */
export function MeetingCreatedStep({
  onDone,
  onBack,
  onForward,
  scheduledTime,
  awaitingTime,
}: {
  onDone: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
  /** Pre-formatted wall-clock time (e.g. "2:30 PM"); generic copy when absent. */
  scheduledTime?: string;
  /** True while the check-in booking is still in flight; holds the step (capped) so a slow-but-successful booking can still reveal the time. */
  awaitingTime?: boolean;
}) {
  const { components, chosen } = useChosenAvatar();
  const reduce = useReducedMotion();
  const { w, h } = useViewportSize();

  const title = scheduledTime
    ? `Check-in scheduled for tomorrow at ${scheduledTime}!`
    : "Check-in scheduled!";

  // Hold the step long enough to reveal the booked time. While a booking is
  // still in flight and we don't yet have the time, wait up to the cap; once
  // the time lands (or the booking settles, or we were never waiting) advance
  // after the normal minimum. The effect re-runs when those inputs change, so
  // the timer re-anchors to the moment the time arrives.
  useEffect(() => {
    const holdForBooking = awaitingTime && !scheduledTime;
    const delay = holdForBooking ? MEETING_MAX_MS : MEETING_MIN_MS;
    const t = setTimeout(onDone, delay);
    return () => clearTimeout(t);
  }, [onDone, awaitingTime, scheduledTime]);

  // Measure the avatar slot's center so the grow-in animation resolves to the
  // exact resting position the next step's avatar uses — same column, same size
  // — so there's no horizontal (or size) jump between the two steps. Re-measures
  // on resize and when the title swaps (e.g. the booked time lands late).
  const slotRef = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<{ cx: number; cy: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const r = slotRef.current?.getBoundingClientRect();
      if (r) setSlot({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [title]);

  // The single giant avatar (eyes visible against the colored bg even while the
  // body blends; the body appears as the bg darkens) starts low, dips a touch,
  // then rises + shrinks into the slot with a small settle bounce.
  const bigScale = (1.3 * Math.max(w, h)) / MINI;
  const startX = slot ? w / 2 - slot.cx : 0;
  const startY = slot ? h * 0.88 - slot.cy : 0;
  const dip = h * 0.05;

  return (
    <div className="absolute inset-0 z-10 overflow-hidden text-white">
      <OnboardingTopBar onBack={onBack} onNext={onForward} tone="light" />

      {/* Same column layout as the looking-you-up / result steps so the avatar
          lands exactly where the next step renders it. */}
      <div className="absolute left-1/2 top-[14%] sm:top-[26%] flex w-full max-w-xl -translate-x-1/2 items-start gap-3 px-6">
        <div ref={slotRef} className="relative shrink-0" style={{ width: MINI, height: MINI }}>
          {components && chosen && slot && (
            <motion.div
              className="absolute inset-0"
              style={{ transformOrigin: "center" }}
              initial={reduce ? false : { scale: bigScale, x: startX, y: startY }}
              animate={{
                x: [startX, startX, 0, 0],
                y: [startY, startY + dip, 0, 0],
                scale: [bigScale, bigScale, 1.07, 1],
              }}
              transition={
                reduce
                  ? { duration: 0 }
                  : {
                      duration: 1.1,
                      times: [0, 0.18, 0.82, 1],
                      ease: ["easeOut", "easeIn", "easeOut"],
                    }
              }
            >
              <AnimatedAvatar components={components} traits={chosen} size={MINI} />
            </motion.div>
          )}
        </div>
        <motion.span
          className="text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
          initial={reduce ? false : { opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.4, delay: 0.9 }}
        >
          {title}
        </motion.span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Looking you up (loading carousel)
// ---------------------------------------------------------------------------

const LOOKING_MESSAGES = [
  "Searching the web to get to know you…",
  "Reading public profiles…",
  "Connecting the dots…",
  "Almost there…",
];

/** How long each rotating message lingers before advancing to the next. */
const LOOKING_MESSAGE_INTERVAL_MS = 2800;

export function LookingYouUpStep({
  onDone,
  onBack,
  onAdvance,
  onForward,
  ready,
}: {
  onDone: () => void;
  onBack: () => void;
  /** Reports the current message index — used to pop an edge avatar per line. */
  onAdvance?: (index: number) => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
  /**
   * The research turn has settled (results are ready, or there were none). Until
   * then the carousel keeps rotating — looping the messages — so we never land
   * on an empty "this is what I found" page.
   */
  ready: boolean;
}) {
  const tone = DARK_TONE;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    onAdvance?.(index);
    const isLast = index >= LOOKING_MESSAGES.length - 1;
    // Finish on the last message once research is ready; otherwise keep cycling
    // (looping back to the start) until it lands.
    if (ready && isLast) {
      const done = setTimeout(onDone, LOOKING_MESSAGE_INTERVAL_MS);
      return () => clearTimeout(done);
    }
    const next = setTimeout(
      () => setIndex((i) => (i + 1) % LOOKING_MESSAGES.length),
      LOOKING_MESSAGE_INTERVAL_MS,
    );
    return () => clearTimeout(next);
  }, [index, ready, onDone, onAdvance]);

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />
      {/* Top-align so the avatar stays put as messages change line count
          (centering would bob it up and down between carousel lines). */}
      <div className="absolute left-1/2 top-[14%] sm:top-[26%] flex w-full max-w-xl -translate-x-1/2 items-start gap-3 px-6">
        <MiniAssistant isStreaming />
        <AnimatePresence mode="wait">
          <motion.p
            key={index}
            className="text-[2.6rem] leading-none"
            style={{ fontFamily: "var(--font-serif)" }}
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
            transition={{ duration: 0.35 }}
          >
            {LOOKING_MESSAGES[index]}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Research results ("Alright, this is what I got:")
// ---------------------------------------------------------------------------

export function ResearchResultsStep({
  claims,
  loading,
  onContinue,
  onRejectAll,
  onBack,
  onForward,
}: {
  /** Parsed research claims (streams in; may be empty while still running). */
  claims: ResearchFact[];
  /** True while the research turn is still streaming. */
  loading: boolean;
  /**
   * Continue into the suggestions, reporting the claims the user X'd out (their
   * exact `claim` text) so the assistant can be told to disregard them — pruning
   * an option here must actually take it out of the assistant's context, not
   * just hide the row.
   */
  onContinue: (removedClaims: string[]) => void;
  /**
   * "This is not me" — the whole search matched someone else (a similar-name
   * mismatch). Discard ALL of the web-research context and continue.
   */
  onRejectAll: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  const tone = DARK_TONE;
  const reduce = useReducedMotion();
  // Locally track removed claims by their text so a user can prune what's wrong
  // without mutating the streamed list (which may still be growing).
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const visible = claims.filter((c) => !removed.has(c.claim));
  const hasClaims = visible.length > 0;
  const canContinue = !loading;

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[14%] sm:top-[26%] z-10 flex w-full max-w-xl -translate-x-1/2 flex-col px-6">
        <div className="flex items-center gap-3">
          <MiniAssistant />
          <h1 className="text-[2.2rem] leading-none" style={{ fontFamily: "var(--font-serif)" }}>
            This is what I found about you
          </h1>
        </div>
        <p className="mb-7 mt-2 text-[15px]" style={{ color: tone.fgMuted }}>
          {hasClaims
            ? loading
              ? "Still checking the rest. You can review these as they come in."
              : "I searched the web. Feel free to remove anything that isn’t true"
            : loading
              ? "Still putting this together…"
              : "I didn’t turn up much — we can fill it in as we chat."}
        </p>

        <div className="flex flex-col gap-3">
          <AnimatePresence>
            {visible.map((fact) => (
              <motion.div
                key={fact.claim}
                layout
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, scale: 0.95 }}
                className="flex items-center justify-between gap-3 rounded-2xl px-5 py-4 text-[15px]"
                style={{
                  backgroundColor: tone.isLight
                    ? "rgba(0,0,0,0.06)"
                    : "rgba(255,255,255,0.1)",
                }}
              >
                <span>{fact.claim}</span>
                <button
                  type="button"
                  aria-label={`Remove "${fact.claim}"`}
                  onClick={() =>
                    setRemoved((prev) => new Set(prev).add(fact.claim))
                  }
                  className="flex cursor-pointer h-6 w-6 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-100"
                  style={{ color: tone.fgMuted }}
                >
                  <X className="h-4 w-4" />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* The whole search can land on the wrong person (similar names). Let the
            user disown it in one click — continue with no web-research context at
            all, telling the assistant to forget everything it found. Only once
            there's something to reject and the turn has settled. */}
        {hasClaims && canContinue && (
          <button
            type="button"
            onClick={onRejectAll}
            className="mt-5 self-start cursor-pointer text-[14px] underline underline-offset-2 transition-opacity hover:opacity-80"
            style={{ color: tone.fgMuted }}
          >
            This is not me
          </button>
        )}

        <button
          type="button"
          onClick={() => onContinue([...removed])}
          disabled={!canContinue}
          className="mt-8 flex cursor-pointer h-11 w-[200px] items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition duration-150 enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
            color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
          }}
        >
          {canContinue ? "Continue" : "Still searching…"}
          {canContinue && <ArrowRight className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * Generic fallbacks shown only if the research turn produced no suggestions
 * (failure / sparse subject) so the step is never empty once it's done loading.
 * Each pairs the assistant-voiced card text with the user-voiced prompt sent on
 * click.
 */
const FALLBACK_SUGGESTIONS: ResearchSuggestion[] = [
  {
    suggestion: "I'll pull together a quick brief on what's new in your field",
    prompt: "Give me a quick brief on what's new in my field right now.",
  },
  {
    suggestion: "I'll send a weekly briefing on news in your space",
    prompt: "Set up a weekly briefing on news in my space.",
  },
  {
    suggestion: "I'll help you get on top of your week",
    prompt: "Help me get on top of my week.",
  },
  {
    suggestion: "I'll draft something from a few rough notes",
    prompt: "Draft something from a few rough notes I'll give you.",
  },
];

/** A plugin name rendered as a pill tinted with the chosen avatar's color. */
function PluginPill({ label, tone }: { label: string; tone: OnboardingTone }) {
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-[3px] text-[12px] font-medium align-middle"
      style={{ backgroundColor: tone.bg, color: tone.fg }}
    >
      {label}
    </span>
  );
}

/** Interleave plugin pills with readable connectors: "A", "A and B", "A, B, and C". */
function joinPills(labels: string[], tone: OnboardingTone) {
  return labels.map((label, i) => {
    let connector = "";
    if (i > 0) {
      const isLast = i === labels.length - 1;
      connector = isLast ? (labels.length === 2 ? " and " : ", and ") : ", ";
    }
    return (
      <Fragment key={label}>
        {connector}
        <PluginPill label={label} tone={tone} />
      </Fragment>
    );
  });
}

/** Avatar box size — the same at the heading and where it lands by the note. */
const HEADING_AVATAR = 64;
const NOTE_AVATAR = HEADING_AVATAR;

type Anchor = { x: number; y: number };

/**
 * The "already set up …" confirmation line. No avatar of its own — it just
 * reserves a small landing slot (`slotRef`) for the single avatar that flies
 * down from the heading — and names the installed plugins as avatar-tinted
 * pills.
 */
function PluginSetupNote({
  pluginLabels,
  tone,
  pillTone,
  reduce,
  slotRef,
  revealed,
}: {
  pluginLabels: string[];
  /** Surface tone for the line's text (constant light on the dark surface). */
  tone: OnboardingTone;
  /** Avatar tone for the pills (their fill + contrast text). */
  pillTone: OnboardingTone;
  reduce: boolean | null;
  slotRef: React.RefObject<HTMLDivElement | null>;
  /** True once the avatar has landed — the text only appears then. */
  revealed: boolean;
}) {
  const plural = pluginLabels.length > 1;
  return (
    <div className="mt-12 flex items-center gap-3">
      <div
        ref={slotRef}
        className="shrink-0"
        style={{ width: NOTE_AVATAR, height: NOTE_AVATAR }}
      />
      <motion.p
        className="text-[14px]"
        style={{ color: tone.fg }}
        initial={false}
        animate={{ opacity: revealed ? 1 : 0, x: revealed ? 0 : -6 }}
        transition={reduce ? { duration: 0 } : { duration: 0.35 }}
      >
        Already set up the {joinPills(pluginLabels, pillTone)} plugin{plural ? "s" : ""}{" "}
        to help with your work
      </motion.p>
    </div>
  );
}

/**
 * The chosen avatar as a single overlay that rests over the heading and — once
 * the plugin note is present and the layout has settled — flies down along a
 * curved arc to the note's landing slot and stays there (shrinking from the
 * heading size to the note size). Positions are measured from the slots so the
 * flight tracks the real layout as suggestions stream in.
 */
function FlyingHeadingAvatar({
  head,
  note,
  flyToNote,
  reduce,
  onLanded,
}: {
  head: Anchor;
  note?: Anchor;
  flyToNote: boolean;
  reduce: boolean | null;
  /** Fired when the flight to the note finishes (gates the note text reveal). */
  onLanded: () => void;
}) {
  const { components, chosen } = useChosenAvatar();
  if (!components || !chosen) return null;

  const half = HEADING_AVATAR / 2;
  const landing = flyToNote && note ? note : head;

  // Same size throughout (no shrink); straight vertical drop into the note slot.
  const animate = {
    x: landing.x - half,
    y: landing.y - half,
  };

  return (
    <motion.div
      className="pointer-events-none absolute left-0 top-0"
      style={{ width: HEADING_AVATAR, height: HEADING_AVATAR, transformOrigin: "center" }}
      initial={false}
      animate={animate}
      transition={
        reduce
          ? { duration: 0 }
          : flyToNote && note
            ? { type: "spring", duration: 0.9, bounce: 0.45 }
            : { duration: 0.4 }
      }
      onAnimationComplete={() => {
        if (flyToNote && note) onLanded();
      }}
    >
      <AnimatedAvatar components={components} traits={chosen} size={HEADING_AVATAR} />
    </motion.div>
  );
}

export function SuggestionsStep({
  suggestions,
  loading,
  installedPlugins = [],
  onSuggestionClick,
  onSkip,
  onBack,
  onForward,
}: {
  /** Parsed research suggestions (streams in; may be empty while running). */
  suggestions: ResearchSuggestion[];
  /** True while the research turn is still streaming. */
  loading: boolean;
  /**
   * Capabilities installed for the assistant this run (from the model's
   * persona-level `plugins` picks, already catalog-gated). Surfaced as a small
   * confirmation note; empty when none were set up.
   */
  installedPlugins?: string[];
  /** Opens the chat on the clicked suggestion (sends its user-voiced prompt). */
  onSuggestionClick: (suggestion: ResearchSuggestion) => void;
  /** Skips the suggestions and drops the user straight into a blank chat. */
  onSkip: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  // Constant dark surface for the UI; the avatar tone is only for the pills.
  const tone = DARK_TONE;
  const avatarTone = useOnboardingTone();
  const reduce = useReducedMotion();
  // Show real suggestions as they arrive; only fall back once the turn settles
  // with nothing, so we never flash generic prompts over an in-flight result.
  const items =
    suggestions.length > 0
      ? suggestions
      : loading
        ? []
        : FALLBACK_SUGGESTIONS;

  const pluginLabels = installedPlugins
    .map(pluginDisplayName)
    .filter((label) => label.length > 0);
  const hasNote = pluginLabels.length > 0;

  // A single avatar starts over the heading slot and flies down to the note's
  // landing slot. We measure both slot centers (relative to the column) so the
  // flight follows the real layout as suggestions stream in and reflow.
  const columnRef = useRef<HTMLDivElement>(null);
  const headSlotRef = useRef<HTMLDivElement>(null);
  const noteSlotRef = useRef<HTMLDivElement>(null);
  const [anchors, setAnchors] = useState<{ head: Anchor; note?: Anchor } | null>(
    null,
  );
  const [flown, setFlown] = useState(false);
  const [landed, setLanded] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const col = columnRef.current;
      const head = headSlotRef.current;
      if (!col || !head) return;
      const c = col.getBoundingClientRect();
      const center = (r: DOMRect): Anchor => ({
        x: r.left - c.left + r.width / 2,
        y: r.top - c.top + r.height / 2,
      });
      const note = noteSlotRef.current;
      setAnchors({
        head: center(head.getBoundingClientRect()),
        note: note ? center(note.getBoundingClientRect()) : undefined,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // Intentionally not re-measuring on `flown`: the head anchor must stay at
    // its pre-collapse position so the flight starts from where the avatar sat.
  }, [items.length, hasNote]);

  // Fly down the moment we have the data: as soon as the note slot is measured.
  const noteY = anchors?.note?.y;
  useEffect(() => {
    if (!hasNote || noteY === undefined || flown) return;
    setFlown(true);
  }, [hasNote, noteY, flown]);

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div
        ref={columnRef}
        className="absolute left-1/2 top-[14%] sm:top-[26%] z-10 flex w-full max-w-xl -translate-x-1/2 flex-col px-6"
      >
        <div className="flex items-center">
          {/*
            Empty slot the flying avatar rests over. Once the avatar departs
            (`flown`), it collapses its width + right margin so the title slides
            smoothly to left-aligned.
          */}
          <motion.div
            ref={headSlotRef}
            className="shrink-0"
            style={{ height: HEADING_AVATAR }}
            initial={false}
            animate={
              flown
                ? { width: 0, marginRight: 0 }
                : { width: HEADING_AVATAR, marginRight: 12 }
            }
            transition={reduce ? { duration: 0 } : { duration: 0.5, ease: "easeInOut" }}
          />
          <h1 className="text-[2.2rem] leading-none" style={{ fontFamily: "var(--font-serif)" }}>
            Here&rsquo;s what we could do first
          </h1>
        </div>
        <p className="mb-7 mt-2 text-[15px]" style={{ color: tone.fgMuted }}>
          {items.length > 0 ? (
            <>
              Pick one to jump in — or start your own thing.{" "}
              <button
                type="button"
                onClick={onSkip}
                className="cursor-pointer underline underline-offset-2 transition-opacity hover:opacity-80"
                style={{ color: tone.fg }}
              >
                Skip to Chat
              </button>
            </>
          ) : (
            "Putting together a few ideas…"
          )}
        </p>

        <div className="flex flex-col gap-3">
          {items.map((s, i) => (
            <motion.button
              key={`${i}-${s.suggestion}`}
              type="button"
              onClick={() => onSuggestionClick(s)}
              initial={reduce ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reduce ? { duration: 0 } : { duration: 0.3, delay: i * 0.06 }
              }
              className="cursor-pointer rounded-2xl px-5 py-4 text-left text-[15px] transition-transform duration-150 hover:scale-[1.01] active:scale-[0.99]"
              style={{
                backgroundColor: tone.isLight
                  ? "rgba(0,0,0,0.06)"
                  : "rgba(255,255,255,0.1)",
              }}
            >
              <span>{s.suggestion}</span>
            </motion.button>
          ))}
        </div>

        {hasNote && (
          <PluginSetupNote
            pluginLabels={pluginLabels}
            tone={tone}
            pillTone={avatarTone}
            reduce={reduce}
            slotRef={noteSlotRef}
            revealed={landed}
          />
        )}

        {anchors && (
          <FlyingHeadingAvatar
            head={anchors.head}
            note={anchors.note}
            flyToNote={flown && hasNote && anchors.note !== undefined}
            reduce={reduce}
            onLanded={() => setLanded(true)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Let's chat (plugins-ready terminal step)
// ---------------------------------------------------------------------------

/**
 * Terminal step for the personality-onboarding flow (replaces SuggestionsStep
 * when that flag is on). The suggestions idea is retired: instead this confirms
 * the capabilities already set up for the assistant — chosen from the user's
 * role, hobby, and what the web research surfaced — and offers a single "Let's
 * chat" button. Clicking primes a fresh chat with a hidden kickoff message so
 * the assistant opens by proactively greeting the user in the persona they just
 * configured.
 *
 * Reuses SuggestionsStep's plugin choreography: one avatar rests over the
 * heading and flies down to land beside the "already set up …" note once the
 * installed plugins are known.
 */
export function LetsChatReadyStep({
  installedPlugins = [],
  pluginCatalog = {},
  onStart,
  onBack,
  onForward,
}: {
  /**
   * Capabilities installed for the assistant this run (deterministic floor +
   * the model's persona-level picks, catalog-gated). Surfaced as cards; empty
   * when none were set up.
   */
  installedPlugins?: string[];
  /** Name → description for the installed plugins, for the card subtitles. */
  pluginCatalog?: Record<string, string>;
  /**
   * Enter the chat: awaits any in-flight plugin installs / corrections, then
   * hands off to the primed conversation. May be async — the button shows a
   * pending state until it resolves.
   */
  onStart: () => void | Promise<void>;
  onBack: () => void;
  /** Redo into this step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  // Constant dark surface for the UI text; the avatar tone colors the pills.
  const tone = DARK_TONE;
  const avatarTone = useOnboardingTone();
  const reduce = useReducedMotion();
  const [starting, setStarting] = useState(false);

  // Each installed plugin as a card: its display name + (when known) the
  // catalog description. Names without a display label are dropped.
  const plugins = installedPlugins
    .map((name) => ({
      name,
      displayName: pluginDisplayName(name),
      description: pluginCatalog[name]?.trim() ?? "",
    }))
    .filter((p) => p.displayName.length > 0);
  const hasPlugins = plugins.length > 0;

  // A single avatar starts over the heading slot and flies down to the note's
  // landing slot — same choreography as SuggestionsStep. The note sits BELOW the
  // plugin cards, so we re-measure when the card count changes to keep the
  // flight landing on the real note position.
  const columnRef = useRef<HTMLDivElement>(null);
  const headSlotRef = useRef<HTMLDivElement>(null);
  const noteSlotRef = useRef<HTMLDivElement>(null);
  const [anchors, setAnchors] = useState<{ head: Anchor; note?: Anchor } | null>(
    null,
  );
  const [flown, setFlown] = useState(false);
  const [landed, setLanded] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const col = columnRef.current;
      const head = headSlotRef.current;
      if (!col || !head) return;
      const c = col.getBoundingClientRect();
      const center = (r: DOMRect): Anchor => ({
        x: r.left - c.left + r.width / 2,
        y: r.top - c.top + r.height / 2,
      });
      const note = noteSlotRef.current;
      setAnchors({
        head: center(head.getBoundingClientRect()),
        note: note ? center(note.getBoundingClientRect()) : undefined,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // Intentionally not re-measuring on `flown`: the head anchor must stay at
    // its pre-collapse position so the flight starts from where the avatar sat.
  }, [plugins.length]);

  // Fly down the moment the note slot is measured (the note always renders).
  const noteY = anchors?.note?.y;
  useEffect(() => {
    if (noteY === undefined || flown) return;
    setFlown(true);
  }, [noteY, flown]);

  const handleStart = () => {
    if (starting) return;
    setStarting(true);
    // If the handoff rejects, re-enable the button so the user can retry.
    void Promise.resolve()
      .then(onStart)
      .catch(() => setStarting(false));
  };

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div
        ref={columnRef}
        className="absolute left-1/2 top-1/2 z-10 flex w-full max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col px-6"
      >
        <div className="flex items-center">
          {/*
            Empty slot the flying avatar rests over. Once the avatar departs
            (`flown`), it collapses its width + right margin so the title slides
            smoothly to left-aligned.
          */}
          <motion.div
            ref={headSlotRef}
            className="shrink-0"
            style={{ height: HEADING_AVATAR }}
            initial={false}
            animate={
              flown
                ? { width: 0, marginRight: 0 }
                : { width: HEADING_AVATAR, marginRight: 12 }
            }
            transition={reduce ? { duration: 0 } : { duration: 0.5, ease: "easeInOut" }}
          />
          <h1 className="text-[2.2rem] leading-none" style={{ fontFamily: "var(--font-serif)" }}>
            You&rsquo;re all set
          </h1>
        </div>

        {/* One entry per installed plugin: the name as an avatar-tinted pill,
            the description directly beneath it (no card container). Directly
            under the title. */}
        {hasPlugins && (
          <div className="mt-6 flex flex-col gap-5">
            {plugins.map((p, i) => (
              <motion.div
                key={p.name}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  reduce ? { duration: 0 } : { duration: 0.3, delay: i * 0.06 }
                }
                className="flex flex-col items-start gap-1.5"
              >
                <span
                  className="inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-[14px] font-medium"
                  style={{
                    backgroundColor: avatarTone.bg,
                    color: avatarTone.fg,
                  }}
                >
                  {p.displayName}
                </span>
                {p.description && (
                  <p
                    className="text-[14px] leading-snug"
                    style={{ color: tone.fgMuted }}
                  >
                    {p.description}
                  </p>
                )}
              </motion.div>
            ))}
          </div>
        )}

        {/* The avatar line below the cards. No avatar of its own — it reserves a
            landing slot (`noteSlotRef`) for the single avatar that flies down
            from the heading, mirroring SuggestionsStep. The margin is generous
            because the flown 64px avatar overflows this collapsed row (~22px),
            so the visual gap above/below it matches the title→first-card gap. */}
        <div className="mt-16 flex items-center gap-3">
          {/* Reserves the avatar's horizontal room but not its full height, so
              the row is only as tall as the text and the flown avatar lands
              vertically centered on the line (not within a 64px box). */}
          <div
            ref={noteSlotRef}
            className="shrink-0"
            style={{ width: NOTE_AVATAR }}
          />
          <motion.p
            className="text-[15px]"
            style={{ color: tone.fg }}
            initial={false}
            animate={{ opacity: landed ? 1 : 0, x: landed ? 0 : -6 }}
            transition={reduce ? { duration: 0 } : { duration: 0.35 }}
          >
            I&rsquo;ve set myself up with plugins around who you are.
          </motion.p>
        </div>

        <button
          type="button"
          onClick={handleStart}
          disabled={starting}
          className="mt-16 flex cursor-pointer h-11 w-[200px] items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition duration-150 enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
            color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
          }}
        >
          {starting ? "Starting…" : "Let's chat"}
          {!starting && <ArrowRight className="h-4 w-4" />}
        </button>

        {anchors && (
          <FlyingHeadingAvatar
            head={anchors.head}
            note={anchors.note}
            flyToNote={flown && anchors.note !== undefined}
            reduce={reduce}
            onLanded={() => setLanded(true)}
          />
        )}
      </div>
    </div>
  );
}
