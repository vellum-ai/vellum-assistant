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

import { Button, Dropdown, Input, Typography } from "@vellumai/design-library";
import type { DropdownOption } from "@vellumai/design-library";

import { AppleLogo } from "@/components/icons/apple-logo";
import { GoogleLogo } from "@/components/icons/google-logo";
import { publicAsset } from "@/utils/public-asset";
import { RotatingWord } from "@/domains/onboarding/cast/cast-shell";
import type {
  LoginIdentity,
  LoginScreenProps,
} from "@/domains/onboarding/cast/screens/screen-slot";
import { useAuthStore, useIsAuthenticated } from "@/stores/auth-store";
import "@/domains/onboarding/cast/cast.css";

export type { LoginIdentity };

/** Sentinel for the "Other…" role option that reveals a free-text input. */
const OTHER_ROLE = "__other__";

/**
 * Curated role list for the occupation dropdown. `occupation` is a free string
 * downstream (persona + research directive), so the values are the plain role
 * labels; the trailing "Other…" option reveals a free-text input so a role
 * outside this list is never lost.
 */
const ROLE_OPTIONS: DropdownOption<string>[] = [
  { value: "Software Engineer", label: "Software Engineer" },
  { value: "Product Manager", label: "Product Manager" },
  { value: "Designer", label: "Designer" },
  { value: "Founder / CEO", label: "Founder / CEO" },
  { value: "Marketing", label: "Marketing" },
  { value: "Sales", label: "Sales" },
  { value: "Operations", label: "Operations" },
  { value: "Finance / Accounting", label: "Finance / Accounting" },
  { value: "Data / Analytics", label: "Data / Analytics" },
  { value: "Customer Success / Support", label: "Customer Success / Support" },
  { value: "People / Recruiting", label: "People / Recruiting" },
  { value: "Consultant", label: "Consultant" },
  { value: "Student", label: "Student" },
  { value: "Researcher", label: "Researcher" },
  { value: "Writer / Creator", label: "Writer / Creator" },
  { value: OTHER_ROLE, label: "Other…" },
];

export function LoginScreen({ onAdvance, onContinue, onIdentity }: LoginScreenProps) {
  // The cast arm only runs post-auth/post-consent, so the sign-in buttons are
  // mock theatre. When already authenticated, skip the fake sign-in stage and
  // render the about-you form directly; the provider-button path survives only
  // for the (unexpected) unauthenticated case.
  const isAuthenticated = useIsAuthenticated();
  // Prefill name from the signup identity (WorkOS/allauth `first_name` /
  // `last_name`, exposed as `firstName`/`lastName` on the auth user). These can
  // be empty strings when the provider didn't supply them — still fully
  // editable below.
  const user = useAuthStore.use.user();
  const [loggedIn, setLoggedIn] = useState(isAuthenticated);
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  // Occupation is a dropdown with an "Other…" escape hatch: `roleSelection` is
  // the picked option; `roleOther` holds free text when "Other…" is chosen.
  const [roleSelection, setRoleSelection] = useState("");
  const [roleOther, setRoleOther] = useState("");
  const [exiting, setExiting] = useState(false);

  // Reveal the about-you form once a provider is chosen (mock sign-in). Only
  // reachable on the unauthenticated fallback path.
  function handleLogin() {
    if (loggedIn) return;
    setLoggedIn(true);
  }

  // The effective role string that flows to occupation downstream.
  const role = roleSelection === OTHER_ROLE ? roleOther.trim() : roleSelection;

  const canContinue =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    role.length > 0;

  function handleContinue() {
    if (exiting || !canContinue) return;
    setExiting(true);
    const identity: LoginIdentity = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role,
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
                    <motion.div
                      key={btn.label}
                      className="cast-login__btn-row"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: 0.38 + i * 0.08 }}
                    >
                      {i === 0 && (
                        <span className="cast-login__tag">Most used</span>
                      )}
                      <Button
                        variant="outlined"
                        fullWidth
                        leftIcon={btn.icon}
                        className="cast-login__btn"
                        onClick={handleLogin}
                      >
                        {btn.label}
                      </Button>
                    </motion.div>
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

                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.75 }}
                >
                  <Button
                    asChild
                    variant="outlined"
                    leftIcon={<AppleLogo size={16} />}
                    className="cast-login__download"
                  >
                    <a href="/downloads">Download for macOS</a>
                  </Button>
                </motion.div>
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
                  <Input
                    fullWidth
                    label={
                      <>
                        What should I call you?{" "}
                        <span className="cast-about__req">*</span>
                      </>
                    }
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
                  <Input
                    fullWidth
                    label={
                      <>
                        And your last name?{" "}
                        <span className="cast-about__req">*</span>
                      </>
                    }
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
                  <Typography
                    as="label"
                    variant="body-small-default"
                    htmlFor="cast-role"
                    className="text-[var(--content-secondary)]"
                  >
                    Your role <span className="cast-about__req">*</span>
                  </Typography>
                  <Dropdown
                    id="cast-role"
                    options={ROLE_OPTIONS}
                    value={roleSelection}
                    onChange={setRoleSelection}
                    placeholder="Select your role"
                    aria-label="Your role"
                  />
                  {roleSelection === OTHER_ROLE && (
                    <Input
                      fullWidth
                      type="text"
                      placeholder="What's your role?"
                      value={roleOther}
                      onChange={(e) => setRoleOther(e.target.value)}
                      aria-label="Your role"
                      autoFocus
                    />
                  )}
                </motion.div>

                <motion.div
                  className="cast-about__step"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35 }}
                >
                  <Button
                    variant="primary"
                    fullWidth
                    className="cast-about__continue"
                    onClick={handleContinue}
                    disabled={!canContinue}
                  >
                    Continue &rarr;
                  </Button>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
