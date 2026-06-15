import { motion } from "motion/react";
import { type ReactNode } from "react";

import { publicAsset } from "@/utils/public-asset";

import "@/domains/account/components/personal-page-signup.css";

/**
 * Two-column activation-flow shell ported from the cast prototype: brand + form
 * on the left, a full-bleed looping product video on the right (hidden under
 * 768px). Used by both the sign-up screen and the post-OAuth name/occupation
 * step so the experience stays visually consistent across the flow.
 */
export function PersonalPageShell({ children }: { children: ReactNode }) {
  return (
    // Force the dark palette regardless of the app theme — the demo always sits
    // on a dark surface. `data-theme="dark"` re-declares the design tokens for
    // this subtree (custom props inherit down), so the white logo + light text
    // read correctly even when the app is in light mode.
    <motion.div
      data-theme="dark"
      className="cast-login"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      <div className="cast-login__left">
        <div className="cast-login__logo">
          <img
            src={publicAsset("/vellum-logo-white.svg")}
            alt="Vellum"
            width={82}
            height={25}
          />
        </div>
        <div className="cast-login__form">{children}</div>
      </div>

      <motion.div
        className="cast-login__right"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.15 }}
        aria-hidden
      >
        <video
          className="cast-login__video"
          src={publicAsset("/vellum-scene-cut.mp4")}
          autoPlay
          loop
          muted
          playsInline
        />
      </motion.div>
    </motion.div>
  );
}
