/**
 * "Want to connect your first integration?" step content.
 *
 * SPIKE — research-onboarding flow.
 *
 * Foreground only (the toned backdrop sits behind). Offers 10 free credits. On
 * Claim the coin drops toward the eyes, the eyes bump it up Mario-style, and it
 * pops up and vanishes — then the flow advances. Not skippable.
 */

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { OnboardingCoin } from "@/domains/onboarding/components/onboarding-coin";
import { OnboardingTopBar } from "@/domains/onboarding/components/onboarding-top-bar";
import { useOnboardingTone } from "@/domains/onboarding/onboarding-tone";

interface IntegrationStepProps {
  onClaim: () => void;
  /** Fire the eyes' upward jolt as the coin reaches them. */
  onBumpEyes: () => void;
  onBack: () => void;
}

/** Coin drop → bump → quick gravity arc up + back down (seconds). The fall is
 *  faster than real gravity for snappiness. `DROP` is when the eyes bump. */
const DROP = 0.3;
const TOTAL = 0.95;

export function IntegrationStep({
  onClaim,
  onBumpEyes,
  onBack,
}: IntegrationStepProps) {
  const reduce = useReducedMotion();
  const tone = useOnboardingTone();
  const [claiming, setClaiming] = useState(false);

  function handleClaim() {
    if (claiming) return;
    setClaiming(true);
    if (reduce) {
      onClaim();
      return;
    }
    // Bump the eyes right as the coin reaches the bottom.
    window.setTimeout(onBumpEyes, DROP * 1000);
  }

  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const dropY = vh * 0.42; // down to the eyes
  const apexY = -vh * 0.08; // bumped just a little above the start
  const fallY = vh * 0.9; // falls away off the bottom

  return (
    <div className="absolute inset-0 z-10" style={{ color: tone.fg }}>
      <OnboardingTopBar
        current={4}
        total={5}
        label="Quick setup"
        onBack={onBack}
        onNext={handleClaim}
        nextDisabled={claiming}
      />

      <div className="absolute left-1/2 top-[26%] flex -translate-x-1/2 flex-col items-center gap-3 text-center">
        <h1
          className="text-[2.6rem] leading-none"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Want to connect your first integration?
        </h1>
        <p className="text-[16px]" style={{ color: tone.fgMuted }}>
          Here&rsquo;s 10 free credits to get you started.
        </p>

        {/* Coin — drops to the eyes, gets bumped up, then falls away (2D flight
            here) while the coin spins in its own 3D context (`spinning`). */}
        <div className="mt-8 flex flex-col items-center gap-4">
          <motion.div
            animate={
              claiming && !reduce
                ? {
                    y: [0, dropY, apexY, fallY],
                    scale: [1, 1, 1, 0.2],
                    opacity: [1, 1, 1, 0],
                  }
                : {}
            }
            transition={{
              duration: TOTAL,
              // Fall into the eyes, get bumped up (decelerating like gravity),
              // then accelerate back down — a quick parabolic arc.
              times: [0, DROP / TOTAL, 0.62, 1],
              ease: ["easeIn", "easeOut", "easeIn"],
            }}
            onAnimationComplete={() => {
              if (claiming) onClaim();
            }}
          >
            <OnboardingCoin size={88} spinning={claiming && !reduce} />
          </motion.div>
          <p className="text-[20px] font-medium" style={{ color: tone.fg }}>10 cr.</p>
        </div>

        {/* Claim — hidden while the coin animates. */}
        {!claiming && (
          <button
            type="button"
            onClick={handleClaim}
            className="mt-6 flex h-11 w-[234px] items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition-transform duration-150 active:scale-[0.97]"
            style={{
              backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
              color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
            }}
          >
            Claim
            <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
