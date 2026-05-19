
import { Link } from "react-router";
import type { CSSProperties, ReactNode } from "react";

import {
  PROVIDER_CALLBACK_URL,
  PROVIDER_ID,
} from "@/lib/account/login-flow.js";
import { startAuthFlow, useIsNativePlatform } from "@/lib/native-auth.js";
import { routes } from "@/lib/routes.js";

interface SignInButtonProps {
  /** Page to return to after auth completes. */
  returnTo?: string | null;
  className?: string;
  style?: CSSProperties;
  /** Web login href (default: "/account/login"). */
  loginHref?: string;
  children?: ReactNode;
}

/**
 * Renders a sign-in action that transparently routes through the native
 * Capacitor auth flow on iOS and falls back to a standard Next.js link
 * on web. Hydration-safe — always server-renders as a `<Link>` and
 * upgrades to a `<button>` after mount on native.
 */
export function SignInButton({
  returnTo,
  className,
  style,
  loginHref = routes.account.login,
  children = "Sign in",
}: SignInButtonProps) {
  const isNative = useIsNativePlatform();

  if (isNative) {
    return (
      <button
        type="button"
        onClick={() =>
          void startAuthFlow(PROVIDER_ID, PROVIDER_CALLBACK_URL, {
            returnTo: returnTo ?? undefined,
          })
        }
        className={className}
        style={style}
      >
        {children}
      </button>
    );
  }

  const href = returnTo
    ? `${loginHref}?returnTo=${encodeURIComponent(returnTo)}`
    : loginHref;

  return (
    <Link to={href} className={className} style={style}>
      {children}
    </Link>
  );
}
