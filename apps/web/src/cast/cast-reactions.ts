import type { Target, Transition } from "motion/react";

import type { Reaction } from "@/cast/cast-roster";

/**
 * Beat-2 autonomous reactions. Each has an `intro` (the ~1.5s personality
 * beat that plays once after the zoom settles) and a `loop` (a subtle motion
 * the character settles into afterward). Whole-character motion only — these
 * avatars are a single SVG with no limbs, so personality is carried by how the
 * body moves, timed to match the eyes.
 */
export interface ReactionMotion {
  intro: { animate: Target; transition: Transition };
  loop: { animate: Target; transition: Transition };
}

const loopFor = (animate: Target, duration: number): ReactionMotion["loop"] => ({
  animate,
  transition: { duration, repeat: Infinity, ease: "easeInOut" },
});

export const REACTIONS: Record<Reaction, ReactionMotion> = {
  // angry — defiant, arms-crossed energy: a hard huff with a stubborn shake.
  huff: {
    intro: {
      animate: {
        rotate: [0, -5, 5, -4, 4, 0],
        scaleX: [1, 1.06, 1.06, 1, 1, 1],
        scaleY: [1, 0.94, 0.94, 1, 1, 1],
        y: [0, 4, 4, 0, 0, 0],
      },
      transition: { duration: 1.5, times: [0, 0.18, 0.36, 0.6, 0.8, 1], ease: "easeInOut" },
    },
    loop: loopFor({ rotate: [0, -1.6, 1.6, 0], y: [0, 1, 0, 0] }, 2.4),
  },

  // grumpy — bored stretch yawn: squash, big stretch up, settle.
  yawn: {
    intro: {
      animate: {
        scaleY: [1, 0.9, 1.22, 1.08, 1],
        scaleX: [1, 1.05, 0.9, 1.02, 1],
        y: [0, 6, -14, -2, 0],
      },
      transition: { duration: 1.6, times: [0, 0.25, 0.55, 0.8, 1], ease: "easeInOut" },
    },
    loop: loopFor({ scaleY: [1, 1.03, 1], scaleX: [1, 0.99, 1] }, 4),
  },

  // curious — peers left and right with a head-cock.
  peer: {
    intro: {
      animate: {
        rotate: [0, -9, 8, -7, 6, 0],
        x: [0, -12, 12, -8, 8, 0],
      },
      transition: { duration: 1.6, ease: "easeInOut" },
    },
    loop: loopFor({ rotate: [0, -3, 3, 0], x: [0, -3, 3, 0] }, 3.2),
  },

  // goofy — a gleeful full spin with a little hop.
  spin: {
    intro: {
      animate: {
        rotate: [0, 360],
        y: [0, -22, 0],
        scale: [1, 1.08, 1],
      },
      transition: { duration: 1.4, ease: "easeInOut" },
    },
    loop: loopFor({ rotate: [0, -4, 4, 0], y: [0, -4, 0] }, 2.2),
  },

  // surprised — a startled jump back.
  startle: {
    intro: {
      animate: {
        y: [0, -32, 0, -10, 0],
        scale: [1, 1.14, 1, 1.04, 1],
      },
      transition: { duration: 1.5, times: [0, 0.18, 0.45, 0.65, 1], ease: "easeOut" },
    },
    loop: loopFor({ y: [0, -3, 0], scale: [1, 1.02, 1] }, 2.6),
  },

  // bashful — leans away, peeking back shyly.
  shy: {
    intro: {
      animate: {
        rotate: [0, 9, 7, 9, 6],
        x: [0, 14, 10, 14, 8],
        scale: [1, 0.95, 0.96, 0.95, 0.97],
      },
      transition: { duration: 1.6, ease: "easeInOut" },
    },
    loop: loopFor({ rotate: [6, 8, 6], x: [8, 11, 8] }, 3.4),
  },

  // gentle — a soft, calm sway.
  sway: {
    intro: {
      animate: { rotate: [0, -5, 5, -4, 0], x: [0, -7, 7, -4, 0] },
      transition: { duration: 1.6, ease: "easeInOut" },
    },
    loop: loopFor({ rotate: [0, -4, 4, 0], x: [0, -5, 5, 0] }, 3.6),
  },

  // quirky — an offbeat, stuttering head tilt.
  tilt: {
    intro: {
      animate: { rotate: [0, -11, 4, -8, 3, 0] },
      transition: { duration: 1.5, times: [0, 0.2, 0.4, 0.6, 0.8, 1], ease: "easeInOut" },
    },
    loop: loopFor({ rotate: [0, -3, 5, -2, 0] }, 3 ),
  },

  // dazed — a woozy circular sway.
  woozy: {
    intro: {
      animate: {
        rotate: [0, 10, -10, 8, -8, 0],
        x: [0, 8, -8, 6, -6, 0],
        y: [0, -4, 4, -3, 3, 0],
      },
      transition: { duration: 1.6, ease: "easeInOut" },
    },
    loop: loopFor({ rotate: [0, 5, -5, 0], x: [0, 4, -4, 0], y: [0, -2, 2, 0] }, 3.4),
  },
};
