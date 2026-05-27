import type { ReactNode } from "react";

import { publicAsset } from "@/lib/public-asset";

/**
 * Full-screen branded splash shown on native iOS during:
 * - Initial login (behind the ASWebAuthenticationSession Safari sheet)
 * - Biometric session recovery (while Face ID / Touch ID is prompting)
 * - Session validation (while checking if the user is still logged in)
 *
 * Centers the Vellum wordmark vertically and displays the character
 * illustrations flush at the bottom of the screen.
 */
export function NativeSplash({ children }: { children?: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[var(--surface-base)] text-[var(--content-default)]">
      <img
        src={publicAsset("/vellum-logo.svg")}
        alt="Vellum"
        width={220}
        height={66}
        className="block dark:hidden"
      />
      <img
        src={publicAsset("/vellum-logo-white.svg")}
        alt="Vellum"
        width={220}
        height={66}
        className="hidden dark:block"
      />
      {children}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 w-full max-w-[900px] -translate-x-1/2"
        style={{ bottom: 0 }}
      >
        <img
          src={publicAsset("/login-background-characters.svg")}
          alt=""
          width={880}
          height={182}
          className="h-auto w-full"
        />
      </div>
    </div>
  );
}
