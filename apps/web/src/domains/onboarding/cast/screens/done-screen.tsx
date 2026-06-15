/**
 * `done` screen — proof / endpoint that finishes the cast onboarding flow.
 *
 * Conforms to `DoneScreenProps` (see `screen-slot.ts`). The character settles
 * and presents the small artifacts it "made", then offers the two endpoints
 * (drop into chat / boost). The proof/endpoint surface itself is the ported
 * sibling `CastProof` (`@/domains/onboarding/cast/cast-proof-view`).
 *
 * The slot contract narrows the proof view's callbacks: `onAction(which)` is
 * widened to a plain string, and `onEndpoint()` takes no argument (the
 * orchestrator decides what "finish" means), so the chat/boost distinction is
 * collapsed here — both route through the single `onEndpoint`.
 *
 * This module also re-exports `HandoffScreen` (ported verbatim from the
 * prototype's `interactive-setup.tsx`). With the prototype's `job` phase gone,
 * `deriveTaskSuggestions` (in `cast-task-derivation`) is the source of truth for
 * the user's tasks; `HandoffScreen` renders those derived tasks and doubles as
 * the loading/handoff visual a later PR shows while awaiting hatch readiness.
 * It keeps its own prop shape (it needs the raw memory list, which is not part
 * of `DoneScreenProps`) so the integration PR can wire it independently.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button, Typography } from "@vellumai/design-library";

import { BlinkingAvatar } from "@/domains/onboarding/cast/cast-shell";
import { CastProof } from "@/domains/onboarding/cast/cast-proof-view";
import { deriveTaskSuggestions } from "@/domains/onboarding/cast/cast-task-derivation";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { MemoryEntry, DoneScreenProps } from "@/domains/onboarding/cast/screens/screen-slot";

export function DoneScreen({
  character,
  box,
  style,
  ascended,
  assistantId,
  onAction,
  onEndpoint,
  onBack,
}: DoneScreenProps) {
  return (
    <CastProof
      character={character}
      box={box}
      // The job/rather phases were collapsed, so the proof visual no longer
      // varies by them — pass empty defaults to satisfy the proof view's shape.
      jobs={[]}
      rathers={[]}
      style={style}
      ascended={ascended}
      assistantId={assistantId}
      onAction={onAction}
      onEndpoint={() => onEndpoint()}
      onBack={() => onBack?.()}
    />
  );
}

/**
 * HandoffScreen — transition screen before dropping into the chat sandbox.
 * Ported verbatim from the prototype's `interactive-setup.tsx`; renders the
 * tasks derived from the onboarding memory list and reveals a "Let's go" CTA
 * after a short beat. Kept as a named export for the later integration PR.
 */
export function HandoffScreen({
  character,
  memories,
  onComplete,
}: {
  character: CastCharacter;
  memories: MemoryEntry[];
  onComplete: () => void;
}) {
  const [showCta, setShowCta] = useState(false);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  const tasks = useMemo(() => deriveTaskSuggestions(memories), [memories]);

  useEffect(() => {
    const ctaTimer = window.setTimeout(() => setShowCta(true), 1800);
    return () => clearTimeout(ctaTimer);
  }, []);

  return (
    <motion.div
      className="absolute inset-0 z-[4] flex flex-col items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <div className="mb-8 h-[200px] w-[200px]">
        <BlinkingAvatar character={character} />
      </div>
      <h2 className="cast-handoff__heading">
        Here's what I found I can take care of for you today
      </h2>
      <ul className="m-0 mt-7 flex w-full max-w-[340px] list-none flex-col gap-2.5 p-0">
        {tasks.map((task, i) => (
          <motion.li
            key={task}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.4 + i * 0.2 }}
          >
            <Typography
              variant="body-medium-default"
              as="div"
              className="rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-hover)] px-[18px] py-3.5 text-center font-semibold text-[var(--content-default)]"
            >
              {task}
            </Typography>
          </motion.li>
        ))}
      </ul>
      <AnimatePresence>
        {showCta && (
          <motion.div
            className="mt-[18px]"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Button variant="ghost" onClick={() => onCompleteRef.current()}>
              Let's go &rarr;
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default DoneScreen;
