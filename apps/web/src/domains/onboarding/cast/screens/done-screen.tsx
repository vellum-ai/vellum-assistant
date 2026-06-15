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

import { BlinkingAvatar } from "@/domains/onboarding/cast/cast-shell";
import { CastProof } from "@/domains/onboarding/cast/cast-proof-view";
import { deriveTaskSuggestions } from "@/domains/onboarding/cast/cast-task-derivation";
import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import type { MemoryEntry, DoneScreenProps } from "@/domains/onboarding/cast/screens/screen-slot";

export function DoneScreen({
  character,
  box,
  jobs,
  rathers,
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
      jobs={jobs}
      rathers={rathers}
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
      className="cast-handoff"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <div style={{ width: 200, height: 200, marginBottom: 32 }}>
        <BlinkingAvatar character={character} />
      </div>
      <h2 className="cast-handoff__heading">
        Here's what I found I can take care of for you today
      </h2>
      <ul className="cast-handoff__tasks">
        {tasks.map((task, i) => (
          <motion.li
            key={task}
            className="cast-handoff__task"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.4 + i * 0.2 }}
          >
            {task}
          </motion.li>
        ))}
      </ul>
      <AnimatePresence>
        {showCta && (
          <motion.button
            className="cast-handoff__cta"
            onClick={() => onCompleteRef.current()}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            Let's go &rarr;
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default DoneScreen;
