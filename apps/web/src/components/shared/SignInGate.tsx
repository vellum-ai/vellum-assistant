
import { Lock } from "lucide-react";

import { SignInButton } from "@/components/shared/SignInButton.js";

interface SignInGateProps {
  /** Descriptive text shown below the heading. */
  description: string;
  /** Page to return to after auth completes (passed through to SignInButton). */
  returnTo?: string | null;
}

/**
 * Full-page gate shown to unauthenticated users on protected pages.
 * Renders the lock icon, "Sign in required" heading, a description, and
 * a sign-in button that routes through native auth on Capacitor iOS.
 *
 * Wrap in a `<Layout>` at the call site — this component only renders
 * the inner content so callers can control the page shell.
 */
export function SignInGate({ description, returnTo }: SignInGateProps) {
  return (
    <div className="flex w-full flex-col items-center justify-center px-4 py-16">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--surface-base)]">
        <Lock className="h-8 w-8 text-[var(--content-disabled)]" />
      </div>
      <h2 className="mt-6 text-title-medium text-[var(--content-default)]">
        Sign in required
      </h2>
      <p className="mt-2 text-center text-body-medium-lighter text-[var(--content-tertiary)]">
        {description}
      </p>
      <SignInButton
        returnTo={returnTo}
        className="mt-6 flex items-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)]"
      />
    </div>
  );
}
