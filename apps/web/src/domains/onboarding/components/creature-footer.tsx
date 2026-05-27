import { publicAsset } from "@/lib/public-asset";

/**
 * Decorative SVG footer pinned to the bottom of every onboarding screen.
 * Uses a plain `<img>` (Vite serves static assets from the public directory
 * or the backend CDN at runtime — no Next.js Image component needed).
 */
export function CreatureFooter({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute bottom-0 left-0 right-0 flex justify-center overflow-hidden ${className}`}
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
