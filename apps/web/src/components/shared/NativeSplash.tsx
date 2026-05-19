
import { AppImage as Image } from "@/adapters/app-image.js";
import type { ReactNode } from "react";

/**
 * Full-screen branded splash shown on native iOS during:
 * - Initial login (behind the ASWebAuthenticationSession Safari sheet)
 * - Biometric session recovery (while Face ID / Touch ID is prompting)
 * - Session validation (while checking if the user is still logged in)
 *
 * Centers the Vellum wordmark vertically and displays the character
 * illustrations flush at the bottom of the screen. The characters are
 * intentionally positioned at `bottom: 0` so they "peek up" from the
 * bottom edge and extend behind the home indicator.
 *
 * Inherits the active color scheme from the `dark` class on `<html>`,
 * which the root layout's inline themeInitScript sets synchronously
 * before hydration based on `localStorage` / `prefers-color-scheme`.
 * Two logo variants are rendered and toggled via Tailwind's `dark:`
 * variant so the correct wordmark shows without a flash.
 */
export function NativeSplash({ children }: { children?: ReactNode }) {
  return (
    <div className="app-root fixed inset-0 z-50 flex flex-col items-center justify-center bg-[var(--surface-base)] text-[var(--content-default)]">
      <Image
        src="/vellum-logo.svg"
        alt="Vellum"
        width={220}
        height={66}
        priority
        className="block dark:hidden"
      />
      <Image
        src="/vellum-logo-white.svg"
        alt="Vellum"
        width={220}
        height={66}
        priority
        className="hidden dark:block"
      />
      {children}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 w-full max-w-[900px] -translate-x-1/2"
        style={{ bottom: 0 }}
      >
        <Image
          src="/login-background-characters.svg"
          alt=""
          width={880}
          height={182}
          className="h-auto w-full"
        />
      </div>
    </div>
  );
}
