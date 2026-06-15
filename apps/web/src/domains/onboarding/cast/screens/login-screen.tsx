/**
 * `login` — sign-in page + inline "about you" form (name + role).
 *
 * Ported from the cast-activation prototype's inline `LoginScreen`. Conforms to
 * `LoginScreenProps` from `screen-slot.ts`.
 *
 * The screen collects `firstName`, `lastName`, and `role`. `onContinue` surfaces
 * only the first name (the shared base); the full payload — including `role`,
 * which the `PreChatOnboardingContext` handoff maps to the downstream occupation
 * — is surfaced via the contract's `onIdentity`. The screen degrades gracefully
 * when `onIdentity` is absent (calls `onContinue` + `onAdvance` regardless).
 */

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { AppleLogo } from "@/components/icons/apple-logo";
import { GoogleLogo } from "@/components/icons/google-logo";
import { publicAsset } from "@/utils/public-asset";
import { RotatingWord } from "@/domains/onboarding/cast/cast-shell";
import type {
  LoginIdentity,
  LoginScreenProps,
} from "@/domains/onboarding/cast/screens/screen-slot";
import { useIsAuthenticated } from "@/stores/auth-store";
import "@/domains/onboarding/cast/cast.css";

export type { LoginIdentity };

export function LoginScreen({ onAdvance, onContinue, onIdentity }: LoginScreenProps) {
  // The cast arm only runs post-auth/post-consent, so the sign-in buttons are
  // mock theatre. When already authenticated, skip the fake sign-in stage and
  // render the about-you form directly; the provider-button path survives only
  // for the (unexpected) unauthenticated case.
  const isAuthenticated = useIsAuthenticated();
  const [loggedIn, setLoggedIn] = useState(isAuthenticated);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState("");
  const [exiting, setExiting] = useState(false);

  // Reveal the about-you form once a provider is chosen (mock sign-in). Only
  // reachable on the unauthenticated fallback path.
  function handleLogin() {
    if (loggedIn) return;
    setLoggedIn(true);
  }

  const canContinue =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    role.trim().length > 0;

  function handleContinue() {
    if (exiting || !canContinue) return;
    setExiting(true);
    const identity: LoginIdentity = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role: role.trim(),
    };
    setTimeout(() => {
      onIdentity?.(identity);
      onContinue(identity.firstName);
      onAdvance();
    }, 450);
  }

  const buttons = [
    { icon: <GoogleLogo size={18} />, label: "Continue with Google" },
    { icon: <AppleLogo size={18} />, label: "Continue with Apple" },
    {
      icon: (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      ),
      label: "Continue with Email",
    },
  ] as const;

  return (
    <motion.div
      className="cast-login"
      initial={{ opacity: 0 }}
      animate={exiting ? { opacity: 0 } : { opacity: 1 }}
      transition={{ duration: exiting ? 0.4 : 0.5 }}
    >
      {/* ---- Left column: brand + form ---- */}
      <div className="cast-login__left">
        <motion.div
          className="cast-login__logo"
          initial={{ opacity: 0 }}
          animate={exiting ? { opacity: 0 } : { opacity: 1 }}
          transition={{ duration: 0.4, delay: exiting ? 0 : 0.1 }}
        >
          <img
            src={publicAsset("/vellum-logo-white.svg")}
            alt="Vellum"
            width={82}
            height={25}
          />
        </motion.div>

        <div className="cast-login__form">
          <AnimatePresence mode="wait">
            {!loggedIn ? (
              <motion.div
                key="signup"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
              >
                <motion.h1
                  className="cast-login__title"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: 0.2 }}
                >
                  Meet your own
                  <br />
                  <RotatingWord
                    words={[
                      "Personal Intelligence",
                      "Software Engineer",
                      "Finance Ops",
                      "Household Manager",
                      "GTM Engineer",
                      "Product Lead",
                    ]}
                  />
                </motion.h1>
                <motion.p
                  className="cast-login__subtitle"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.3 }}
                >
                  The most powerful assistant that can handle your work and life
                  admin tasks.
                </motion.p>

                <div className="cast-login__buttons">
                  {buttons.map((btn, i) => (
                    <motion.button
                      key={btn.label}
                      className="cast-login__btn"
                      onClick={handleLogin}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: 0.38 + i * 0.08 }}
                    >
                      {i === 0 && (
                        <span className="cast-login__tag">Most used</span>
                      )}
                      {btn.icon}
                      {btn.label}
                    </motion.button>
                  ))}
                </div>

                <motion.p
                  className="cast-login__footer"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.65 }}
                >
                  Don&apos;t have an account?{" "}
                  <button className="cast-login__link" onClick={handleLogin}>
                    Sign up
                  </button>
                </motion.p>

                <motion.a
                  className="cast-login__download"
                  href="/downloads"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.75 }}
                >
                  <AppleLogo size={16} />
                  Download for macOS
                </motion.a>
              </motion.div>
            ) : (
              <motion.div
                key="about"
                className="cast-about__thread"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
              >
                <h2 className="cast-about__heading">
                  Almost there,
                  <br />
                  one more detail
                </h2>

                <motion.div
                  className="cast-about__step"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.15 }}
                >
                  <span className="cast-about__label">
                    What should I call you?{" "}
                    <span className="cast-about__req">*</span>
                  </span>
                  <input
                    className="cast-about__input"
                    type="text"
                    placeholder="First name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoFocus
                  />
                </motion.div>

                <motion.div
                  className="cast-about__step"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35 }}
                >
                  <span className="cast-about__label">
                    And your last name?{" "}
                    <span className="cast-about__req">*</span>
                  </span>
                  <input
                    className="cast-about__input"
                    type="text"
                    placeholder="Last name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </motion.div>

                <motion.div
                  className="cast-about__step"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35 }}
                >
                  <span className="cast-about__label">
                    Your role <span className="cast-about__req">*</span>
                  </span>
                  <input
                    className="cast-about__input"
                    type="text"
                    placeholder="e.g. Software Engineer"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  />
                </motion.div>

                <motion.div
                  className="cast-about__step"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35 }}
                >
                  <button
                    className="cast-about__continue"
                    onClick={handleContinue}
                    disabled={!canContinue}
                  >
                    Continue &rarr;
                  </button>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ---- Right column: video ---- */}
      <motion.div
        className="cast-login__right"
        initial={{ opacity: 0 }}
        animate={exiting ? { opacity: 0 } : { opacity: 1 }}
        transition={{ duration: 0.6, delay: exiting ? 0 : 0.15 }}
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
