/**
 * UI-only research-result steps for the research-onboarding flow.
 *
 * SPIKE — research-onboarding flow.
 *
 * These render the visual sequence that follows the calendar step:
 *   - MeetingCreatedStep   a brief "Meeting Created!" confirmation
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

import { useEffect, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import {
  pluginDisplayName,
  type ResearchFact,
  type ResearchSuggestion,
} from "@/utils/research-facts";

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

/** The chosen assistant as a small live avatar (for the heading rows). */
export function MiniAssistant({ size = 48 }: { size?: number }) {
  const { components, chosen } = useChosenAvatar();
  if (!components || !chosen) return <div style={{ width: size, height: size }} />;
  return (
    <div className="shrink-0" style={{ width: size, height: size }}>
      <AnimatedAvatar components={components} traits={chosen} size={size} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meeting Created
// ---------------------------------------------------------------------------

const MINI = 48;

/**
 * Reverse of the Introduction grow-in. The toned backdrop (behind) blends to
 * black and hides its bottom eyes; here the eyes lead — shrinking and rising
 * up out of the bottom (the opposite of growing + sinking) — and the body
 * follows a beat later, shrinking into a small avatar beside the "Meeting
 * Created!" text. The edge characters stay (they live in the backdrop).
 */
export function MeetingCreatedStep({
  onDone,
  onBack,
  onForward,
}: {
  onDone: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  const { components, chosen } = useChosenAvatar();
  const reduce = useReducedMotion();
  const { w, h } = useViewportSize();

  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [onDone]);

  // Mini avatar slot: left of the title, in a left-anchored group.
  const groupLeft = w / 2 - 170;
  const slotCx = groupLeft + MINI / 2;
  const slotCy = h * 0.26 + MINI / 2;

  // The single giant avatar (eyes visible against the colored bg even while the
  // body blends; the body appears as the bg darkens) starts low, dips a touch,
  // then rises + shrinks into the slot with a small settle bounce.
  const bigScale = (1.3 * Math.max(w, h)) / MINI;
  const startX = w / 2 - slotCx;
  const startY = h * 0.88 - slotCy;
  const dip = h * 0.05;

  return (
    <div className="absolute inset-0 z-10 overflow-hidden text-white">
      <OnboardingTopBar onBack={onBack} onNext={onForward} tone="light" />

      <div
        className="absolute flex items-center gap-4"
        style={{ left: groupLeft, top: h * 0.26 }}
      >
        <div className="relative" style={{ width: MINI, height: MINI }}>
          {components && chosen && (
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
          className="whitespace-nowrap text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
          initial={reduce ? false : { opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.4, delay: 0.9 }}
        >
          Meeting Created!
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

export function LookingYouUpStep({
  onDone,
  onBack,
  onAdvance,
  onForward,
}: {
  onDone: () => void;
  onBack: () => void;
  /** Reports the current message index — used to pop an edge avatar per line. */
  onAdvance?: (index: number) => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  const tone = useOnboardingTone();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    onAdvance?.(index);
    if (index >= LOOKING_MESSAGES.length - 1) {
      const done = setTimeout(onDone, 1500);
      return () => clearTimeout(done);
    }
    const next = setTimeout(() => setIndex((i) => i + 1), 1500);
    return () => clearTimeout(next);
  }, [index, onDone, onAdvance]);

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />
      <div className="absolute left-1/2 top-[26%] flex w-full max-w-xl -translate-x-1/2 items-center gap-3 px-6">
        <MiniAssistant />
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
  onBack,
  onForward,
}: {
  /** Parsed research claims (streams in; may be empty while still running). */
  claims: ResearchFact[];
  /** True while the research turn is still streaming. */
  loading: boolean;
  onContinue: () => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  const tone = useOnboardingTone();
  const reduce = useReducedMotion();
  // Locally track removed claims by their text so a user can prune what's wrong
  // without mutating the streamed list (which may still be growing).
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const visible = claims.filter((c) => !removed.has(c.claim));
  const hasClaims = visible.length > 0;

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[26%] z-10 flex w-full max-w-xl -translate-x-1/2 flex-col px-6">
        <div className="flex items-center gap-3">
          <MiniAssistant />
          <h1 className="text-[2.2rem] leading-none" style={{ fontFamily: "var(--font-serif)" }}>
            This is what I found about you
          </h1>
        </div>
        <p className="mb-7 mt-2 text-[15px]" style={{ color: tone.fgMuted }}>
          {hasClaims
            ? "I searched the web. Feel free to remove anything that isn’t true"
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
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-100"
                  style={{ color: tone.fgMuted }}
                >
                  <X className="h-4 w-4" />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <button
          type="button"
          onClick={onContinue}
          className="mt-8 flex h-11 w-[200px] items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition-transform duration-150 active:scale-[0.97]"
          style={{
            backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
            color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
          }}
        >
          Continue
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * Vibrant badge colors handed out to plugins by order of first appearance, so
 * two different plugins on the same screen never collide on one color (a hash
 * would). See `pluginColorByOrder` in `SuggestionsStep`.
 */
const PLUGIN_CHIP_PALETTE = [
  "#6366F1", // indigo
  "#EC4899", // pink
  "#10B981", // emerald
  "#F59E0B", // amber
  "#06B6D4", // cyan
  "#A855F7", // violet
  "#EF4444", // red
  "#14B8A6", // teal
];

/** Black or white text for legibility on a given `#rrggbb` chip color (YIQ). */
function chipTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#FFFFFF";
  const n = parseInt(m[1]!, 16);
  const yiq =
    (((n >> 16) & 0xff) * 299 + ((n >> 8) & 0xff) * 587 + (n & 0xff) * 114) /
    1000;
  return yiq > 150 ? "#1A1A1A" : "#FFFFFF";
}

/**
 * Generic fallbacks shown only if the research turn produced no suggestions
 * (failure / sparse subject) so the step is never empty once it's done loading.
 * Each pairs the assistant-voiced card text with the user-voiced prompt sent on
 * click.
 */
const FALLBACK_SUGGESTIONS: ResearchSuggestion[] = [
  {
    suggestion: "I'll build you a live dashboard to track what matters to you",
    prompt: "Build me a live dashboard to track what matters to me.",
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

export function SuggestionsStep({
  suggestions,
  loading,
  onSuggestionClick,
  onBack,
  onForward,
}: {
  /** Parsed research suggestions (streams in; may be empty while running). */
  suggestions: ResearchSuggestion[];
  /** True while the research turn is still streaming. */
  loading: boolean;
  /**
   * Opens the chat on the clicked suggestion. Receives the whole suggestion so
   * the caller can await any tagged plugin's install before navigating.
   */
  onSuggestionClick: (suggestion: ResearchSuggestion) => void;
  onBack: () => void;
  /** Redo into the next step — only set when the user has stepped back. */
  onForward?: () => void;
}) {
  const tone = useOnboardingTone();
  const reduce = useReducedMotion();
  // Show real suggestions as they arrive; only fall back once the turn settles
  // with nothing, so we never flash generic prompts over an in-flight result.
  const items =
    suggestions.length > 0
      ? suggestions
      : loading
        ? []
        : FALLBACK_SUGGESTIONS;

  // Hand each distinct plugin its own palette color by order of first
  // appearance, so two different plugins never end up the same color.
  const pluginColorByOrder = new Map<string, string>();
  for (const s of items) {
    if (s.plugin && !pluginColorByOrder.has(s.plugin)) {
      pluginColorByOrder.set(
        s.plugin,
        PLUGIN_CHIP_PALETTE[
          pluginColorByOrder.size % PLUGIN_CHIP_PALETTE.length
        ]!,
      );
    }
  }

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar onBack={onBack} onNext={onForward} />

      <div className="absolute left-1/2 top-[26%] z-10 flex w-full max-w-xl -translate-x-1/2 flex-col px-6">
        <div className="flex items-center gap-3">
          <MiniAssistant />
          <h1 className="text-[2.2rem] leading-none" style={{ fontFamily: "var(--font-serif)" }}>
            Here&rsquo;s what we could do first
          </h1>
        </div>
        <p className="mb-7 mt-2 text-[15px]" style={{ color: tone.fgMuted }}>
          {items.length > 0
            ? "Pick one to jump in — or start your own thing."
            : "Putting together a few ideas…"}
        </p>

        <div className="flex flex-col gap-3">
          {items.map((s, i) => {
            const chipBg = s.plugin
              ? pluginColorByOrder.get(s.plugin)
              : undefined;
            return (
              <motion.button
                key={`${i}-${s.suggestion}`}
                type="button"
                onClick={() => onSuggestionClick(s)}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  reduce ? { duration: 0 } : { duration: 0.3, delay: i * 0.06 }
                }
                className="relative rounded-2xl px-5 py-4 text-left text-[15px] transition-transform duration-150 hover:scale-[1.01] active:scale-[0.99]"
                style={{
                  backgroundColor: tone.isLight
                    ? "rgba(0,0,0,0.06)"
                    : "rgba(255,255,255,0.1)",
                }}
              >
                <span>{s.suggestion}</span>
                {s.plugin && chipBg && (
                  // Solid per-plugin colored badge straddling the card's
                  // top-right edge — each plugin gets its own distinct color.
                  <span
                    className="absolute -top-2.5 right-4 inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none"
                    style={{
                      backgroundColor: chipBg,
                      color: chipTextColor(chipBg),
                      boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
                    }}
                  >
                    {pluginDisplayName(s.plugin)}
                  </span>
                )}
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
