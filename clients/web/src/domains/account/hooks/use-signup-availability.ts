import { useEffect, useState } from "react";

import { getAuthConfig } from "@/lib/auth/allauth-client";

export type SignupAvailability = "pending" | "open" | "closed";

/** How long the sign-up page waits on the config probe before failing open. */
export const SIGNUP_AVAILABILITY_TIMEOUT_MS = 5_000;

interface SignupAvailabilityOptions {
  /** `false` skips the probe, for a visit that is not going to sign up. */
  enabled?: boolean;
  timeoutMs?: number;
}

/**
 * Whether the platform accepts new accounts, read from allauth's config
 * endpoint (`account.is_open_for_signup`, which follows the platform's
 * `DJANGO_ACCOUNT_ALLOW_REGISTRATION` setting).
 *
 * Fails open: only a definite `false` closes the sign-up screen. A probe that
 * errors, returns a malformed payload, or stalls past `timeoutMs` leaves the
 * screen in place, and the platform still refuses the registration itself at
 * the end of the OAuth flow.
 */
export function useSignupAvailability({
  enabled = true,
  timeoutMs = SIGNUP_AVAILABILITY_TIMEOUT_MS,
}: SignupAvailabilityOptions = {}): SignupAvailability {
  const [availability, setAvailability] =
    useState<SignupAvailability>("pending");

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let settled = false;
    const settle = (next: SignupAvailability) => {
      if (!settled) {
        settled = true;
        setAvailability(next);
      }
    };
    const deadline = window.setTimeout(() => settle("open"), timeoutMs);
    getAuthConfig().then(
      (result) => {
        settle(
          result.ok && result.data.account.is_open_for_signup === false
            ? "closed"
            : "open",
        );
      },
      () => settle("open"),
    );
    return () => {
      settled = true;
      window.clearTimeout(deadline);
    };
  }, [enabled, timeoutMs]);

  return availability;
}
