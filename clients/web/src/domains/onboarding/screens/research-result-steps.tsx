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
 * are MOCK data for now — the real research streaming/parsing already exists in
 * `domains/chat/onboarding-research` and will be wired into this flow later.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

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
}: {
  onDone: () => void;
  onBack: () => void;
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
      <OnboardingTopBar
        current={4}
        total={5}
        label="Quick setup"
        onBack={onBack}
        tone="light"
      />

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
}: {
  onDone: () => void;
  onBack: () => void;
  /** Reports the current message index — used to pop an edge avatar per line. */
  onAdvance?: (index: number) => void;
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
      <OnboardingTopBar current={4} total={5} label="Quick setup" onBack={onBack} />
      <div className="absolute left-1/2 top-[26%] flex w-full max-w-xl -translate-x-1/2 items-center gap-3 px-6">
        <MiniAssistant />
        <AnimatePresence mode="wait">
          <motion.p
            key={index}
            className="text-[1.6rem]"
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

/** Mock claims, lightly personalized from the collected fields. */
function mockClaims(firstName: string, role: string): string[] {
  const r = role.trim() || "doing interesting work";
  return [
    `You're a ${r}`.replace(/\s+/g, " "),
    firstName.trim() ? `Goes by ${firstName.trim()}` : "Based somewhere sunny",
    "You climb outdoors",
    "Juggles launches, content, and GTM",
  ];
}

export function ResearchResultsStep({
  firstName,
  role,
  onContinue,
  onBack,
}: {
  firstName: string;
  role: string;
  onContinue: () => void;
  onBack: () => void;
}) {
  const tone = useOnboardingTone();
  const reduce = useReducedMotion();
  const initial = useMemo(() => mockClaims(firstName, role), [firstName, role]);
  const [claims, setClaims] = useState(initial);

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar current={4} total={5} label="Almost there" onBack={onBack} />

      <div className="absolute left-1/2 top-[26%] z-10 flex w-full max-w-xl -translate-x-1/2 flex-col px-6">
        <div className="flex items-center gap-3">
          <MiniAssistant />
          <h1 className="text-[2.2rem] leading-none" style={{ fontFamily: "var(--font-serif)" }}>
            Alright, this is what I got:
          </h1>
        </div>
        <p className="mb-7 mt-2 text-[15px]" style={{ color: tone.fgMuted }}>
          Feel free to remove anything that&rsquo;s not true
        </p>

        <div className="flex flex-col gap-3">
          <AnimatePresence>
            {claims.map((claim) => (
              <motion.div
                key={claim}
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
                <span>{claim}</span>
                <button
                  type="button"
                  aria-label={`Remove "${claim}"`}
                  onClick={() => setClaims((cs) => cs.filter((c) => c !== claim))}
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

/** Mock suggestions; clicking opens a new chat with this as the prompt. */
const MOCK_SUGGESTIONS = [
  "Build a live dashboard to track my key metrics",
  "Set up a weekly monitor for news in my space",
  "Draft a launch announcement from my notes",
  "Summarize my unread email each morning",
];

export function SuggestionsStep({
  onSuggestionClick,
  onBack,
}: {
  onSuggestionClick: (prompt: string) => void;
  onBack: () => void;
}) {
  const tone = useOnboardingTone();
  const reduce = useReducedMotion();

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar current={4} total={5} label="Almost there" onBack={onBack} />

      <div className="absolute left-1/2 top-[26%] z-10 flex w-full max-w-xl -translate-x-1/2 flex-col px-6">
        <div className="flex items-center gap-3">
          <MiniAssistant />
          <h1 className="text-[2.2rem] leading-none" style={{ fontFamily: "var(--font-serif)" }}>
            Here&rsquo;s what we could do first
          </h1>
        </div>
        <p className="mb-7 mt-2 text-[15px]" style={{ color: tone.fgMuted }}>
          Pick one to jump in — or start your own thing.
        </p>

        <div className="flex flex-col gap-3">
          {MOCK_SUGGESTIONS.map((s, i) => (
            <motion.button
              key={s}
              type="button"
              onClick={() => onSuggestionClick(s)}
              initial={reduce ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.3, delay: i * 0.06 }}
              className="flex items-center gap-3 rounded-2xl px-5 py-4 text-left text-[15px] transition-transform duration-150 hover:scale-[1.01] active:scale-[0.99]"
              style={{
                backgroundColor: tone.isLight
                  ? "rgba(0,0,0,0.06)"
                  : "rgba(255,255,255,0.1)",
              }}
            >
              <Sparkles className="h-4 w-4 shrink-0" style={{ color: tone.fgMuted }} />
              <span>{s}</span>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}
