import { publicAsset } from "@/utils/public-asset";

/**
 * Decorative SVG footer for onboarding screens.
 *
 * Positioned `fixed` (not `absolute`) so it anchors to the layout viewport
 * bottom and bleeds past `RootLayout`'s `app-shell` bottom safe-area padding
 * + `overflow-hidden` inner wrapper (src/root-layout.tsx). With `absolute`
 * the art floated `env(safe-area-inset-bottom)` (~34px) above the physical
 * edge on iOS, exposing the surface background beneath the creatures. `fixed`
 * escapes the clip and reaches the physical screen bottom; on desktop the
 * inset is 0 so rendering is unchanged. No transformed ancestor exists, so
 * `fixed` resolves against the viewport. `viewport-fit=cover` (index.html)
 * makes the layout viewport span the full physical screen.
 *
 * Uses a plain `<img>` (Vite serves static assets — no Next.js Image needed).
 */
export function CreatureFooter({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed bottom-0 left-0 right-0 flex justify-center overflow-hidden ${className}`}
    >
      <img
        src={publicAsset("/login-background-characters.svg")}
        alt=""
        width={1200}
        height={180}
        className="w-full max-w-[900px] object-cover object-bottom"
      />
    </div>
  );
}
