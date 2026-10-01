import { useEffect, useState } from "react";

import { getAuthConfig } from "@/lib/auth/allauth-client";

export type SignupAvailability = "pending" | "open" | "closed";

/**
 * Whether the platform accepts new accounts, read from allauth's config
 * endpoint (`account.is_open_for_signup`, which follows the platform's
 * `DJANGO_ACCOUNT_ALLOW_REGISTRATION` setting).
 *
 * Fails open: only a definite `false` closes the sign-up screen. A config
 * request that errors leaves the screen in place, and the platform still
 * refuses the registration itself at the end of the OAuth flow.
 */
export function useSignupAvailability(): SignupAvailability {
  const [availability, setAvailability] =
    useState<SignupAvailability>("pending");

  useEffect(() => {
    let cancelled = false;
    getAuthConfig().then(
      (result) => {
        if (cancelled) {
          return;
        }
        setAvailability(
          result.ok && result.data.account.is_open_for_signup === false
            ? "closed"
            : "open",
        );
      },
      () => {
        if (!cancelled) {
          setAvailability("open");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return availability;
}
