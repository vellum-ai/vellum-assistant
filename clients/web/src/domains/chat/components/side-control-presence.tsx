/**
 * How a side control arrives and leaves.
 *
 * Progress and Agents are not standing chrome: each is on screen only while it
 * has something to say, so its appearance IS the notification and its
 * departure is the all-clear. There is no badge or toast doing that job, which
 * puts the whole burden of "notice me" on the motion, hence a slide with a
 * bounce rather than a fade, and an avatar-colored wash on top of it.
 *
 * Three parts:
 *
 *  - **A slide with overshoot**, in from the edge the control is anchored to
 *    and back out the same way. The bounce is the repo's existing back-ease
 *    (`chat-layout`'s rail reveal uses the same curve), so this reads as part
 *    of the app rather than a new motion vocabulary.
 *  - **Direction follows the anchor**: from the right where the cluster floats
 *    in the chat's gutter, from the bottom where it sits above the composer.
 *    Coming from the wrong edge reads as a glitch, because it crosses content
 *    on its way in.
 *  - **The avatar takeover**, the same gesture the assistant page's cards use
 *    when the avatar takes one over (`IdentityOverview`'s flood overlay): an
 *    accent layer whose `clipPath` circle grows or shrinks from an anchor, with
 *    the assistant's own EYES riding on it, sized as they are in the nav row.
 *    Same shape, same easing pair, anchored to the entering edge so the color
 *    and the eyes appear to arrive with the pill and then retreat the way they
 *    came. Together they say whose work this is before you have read anything.
 *
 * An assistant with a CUSTOM avatar image gets the slide and nothing else. The
 * takeover is built from the character avatar's two parts (its accent color
 * and its eye sprite), and a custom image has neither: there is no hue to wash
 * with and no eyes to surface, so the flood would be a grey rectangle over the
 * pill and the eyes simply absent. Better to drop the gesture than to play a
 * hollow version of it.
 *
 * Exit needs an `AnimatePresence` above it; each control provides its own, so
 * the toggle stays inside the component that owns the condition.
 *
 * Honors `prefers-reduced-motion`: no slide, no overshoot, no wash.
 */

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { AssistantEyesMark } from "@/domains/chat/components/assistant-eyes-mark";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** How long the pill wears the avatar color before the wash drains. */
const FLOOD_HOLD_MS = 900;

/**
 * Back-ease with overshoot: the control passes its resting point and settles.
 * Shared with the sidebar rail's reveal so the two bounce identically.
 */
const BOUNCE_EASE = [0.34, 1.56, 0.64, 1] as const;

/** Travel distance for the slide, in px. Far enough to read, short enough to stay quick. */
const SLIDE_PX = 28;

export function SideControlPresence({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const isMobile = useIsMobile();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);
  // The takeover needs both halves of a character avatar. A custom image has
  // neither, so the control just slides in.
  const hasCharacterAvatar =
    !customImageUrl && Boolean(components) && Boolean(traits);
  const takeover = hasCharacterAvatar && !reduceMotion;

  // Starts flooded so the pill's first painted frame is already the avatar
  // color; the drain is what animates, not the fill.
  const [flooded, setFlooded] = useState(true);

  useEffect(() => {
    if (!takeover) {
      setFlooded(false);
      return;
    }
    const id = window.setTimeout(() => setFlooded(false), FLOOD_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [takeover]);

  // Above the composer the cluster's free edge is the bottom; in the chat's
  // gutter it is the right.
  const offset = isMobile ? { y: SLIDE_PX } : { x: SLIDE_PX };
  const rest = isMobile ? { y: 0 } : { x: 0 };
  // The wash follows the same edge, so color and motion agree.
  const floodOrigin = isMobile ? "50% 100%" : "100% 50%";

  return (
    <motion.div
      className="relative"
      initial={reduceMotion ? false : { opacity: 0, ...offset }}
      animate={{ opacity: 1, ...rest }}
      // Leaves the way it came. No overshoot on the way out: a bounce on exit
      // draws attention to something that is finished with.
      exit={
        reduceMotion
          ? { opacity: 0 }
          : {
              opacity: 0,
              ...offset,
              transition: { duration: 0.22, ease: "easeIn" },
            }
      }
      transition={
        reduceMotion ? { duration: 0 } : { duration: 0.46, ease: BOUNCE_EASE }
      }
    >
      {children}
      {takeover ? (
        <>
          {/* The wash. `inset-0` over the pill, clipped to its radius; inert, so it
          never intercepts the click it is drawing attention to. */}
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{
              backgroundColor:
                "var(--avatar-accent, var(--content-emphasised))",
            }}
            initial={false}
            animate={{
              clipPath: flooded
                ? `circle(141% at ${floodOrigin})`
                : `circle(0% at ${floodOrigin})`,
            }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : flooded
                  ? { duration: 0.5, ease: "easeOut" }
                  : { duration: 0.35, ease: "easeIn" }
            }
          />
          {/* The eyes, riding the wash. They fade with it rather than being clipped
          by it: the wash's `clipPath` is on its own layer, and reusing it here
          would cut the sprite in half mid-drain instead of letting it go with
          the color. Centred over the pill and inert, so the glyph underneath
          takes the click. */}
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            initial={false}
            animate={{ opacity: flooded ? 1 : 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { duration: flooded ? 0.25 : 0.3, ease: "easeOut" }
            }
          >
            <AssistantEyesMark assistantId={assistantId} />
          </motion.span>
        </>
      ) : null}
    </motion.div>
  );
}
