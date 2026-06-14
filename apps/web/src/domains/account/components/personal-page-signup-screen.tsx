import { Mail } from "lucide-react";

import { Button, Typography } from "@vellumai/design-library";

import { AccountShell } from "@/components/account/account-shell";
import { AppleLogo } from "@/components/icons/apple-logo";
import { GoogleLogo } from "@/components/icons/google-logo";
import { RotatingWord } from "@/domains/account/components/rotating-word";
import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
} from "@/domains/account/login-flow";
import { startAuthFlow } from "@/runtime/native-auth";
import { publicAsset } from "@/utils/public-asset";

/** Personas cycled in the headline to convey the assistant's breadth. */
const HEADLINE_WORDS = [
  "Personal Intelligence",
  "Software Engineer",
  "Finance Ops",
  "Household Manager",
  "GTM Engineer",
  "Product Lead",
];

const SUBTITLE =
  "The most powerful assistant that can handle your work and life admin tasks.";

interface PersonalPageSignupScreenProps {
  returnTo: string | null;
  /** Surfaces an auth-flow failure to the host page. */
  onError?: (message: string) => void;
}

/**
 * Personal-page activation sign-up screen: a looping product video paired with
 * a rotating headline and the platform's real WorkOS sign-up actions
 * (Apple / Google / Email), matching the canonical login buttons. Email passes
 * no `providerHint`, so WorkOS AuthKit shows its email/password UI. Each button
 * hands off to the same `startAuthFlow` path the standard signup uses, with
 * `intent: "signup"`. The post-OAuth name/occupation step lives in
 * `ProviderSignupPage` (gated by the same flag).
 */
export function PersonalPageSignupScreen({
  returnTo,
  onError,
}: PersonalPageSignupScreenProps) {
  const callbackUrl = buildProviderCallbackUrl(returnTo, {
    authIntent: "signup",
  });

  const start = (providerHint?: string) => {
    startAuthFlow(PROVIDER_ID, callbackUrl, {
      intent: "signup",
      returnTo,
      ...(providerHint ? { providerHint } : {}),
    }).catch((err) => {
      console.error("[signup] auth flow failed:", err);
      onError?.("Something went wrong. Please try again.");
    });
  };

  return (
    <AccountShell>
      <div className="flex flex-col items-center gap-8 md:flex-row md:items-center md:gap-10">
        <video
          src={publicAsset("/vellum-scene-cut.mp4")}
          autoPlay
          loop
          muted
          playsInline
          className="aspect-square w-full max-w-[240px] rounded-xl object-cover md:w-[44%] md:max-w-none"
        />

        <div className="flex w-full flex-col items-center gap-6 text-center md:items-start md:text-left">
          <div className="flex flex-col gap-3">
            <Typography
              variant="title-large"
              as="h1"
              className="text-[var(--content-default)]"
            >
              Meet your own{" "}
              <RotatingWord
                words={HEADLINE_WORDS}
                className="text-[var(--primary-base)]"
              />
            </Typography>
            <Typography
              variant="body-medium-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              {SUBTITLE}
            </Typography>
          </div>

          <div className="flex w-full max-w-[300px] flex-col items-center gap-3">
            <Button
              type="button"
              variant="outlined"
              fullWidth
              onClick={() => start("AppleOAuth")}
              leftIcon={<AppleLogo />}
              className="gap-3"
            >
              Sign up with Apple
            </Button>
            <Button
              type="button"
              variant="outlined"
              fullWidth
              onClick={() => start("GoogleOAuth")}
              leftIcon={<GoogleLogo />}
              className="gap-3"
            >
              Sign up with Google
            </Button>
            <Button
              type="button"
              variant="outlined"
              fullWidth
              onClick={() => start()}
              leftIcon={<Mail />}
              className="gap-3"
            >
              Sign up with Email
            </Button>
          </div>
        </div>
      </div>
    </AccountShell>
  );
}
