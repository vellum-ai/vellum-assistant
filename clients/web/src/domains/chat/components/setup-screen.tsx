
import { useHintRotation } from "@/domains/chat/hooks/use-hint-rotation";

const SETUP_HINTS = [
  "Preparing your workspace\u2026",
  "Configuring your assistant\u2026",
  "Almost there\u2026",
] as const;
const HINT_INTERVAL_MS = 4000;

export function SetupScreen() {
  const hint = useHintRotation(SETUP_HINTS, HINT_INTERVAL_MS);

  return (
    <div className="flex w-full flex-col items-center justify-center px-4 py-24">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--system-positive-weak)]"
        style={{ animation: "fadeInUp 0.5s ease-out forwards" }}
      >
        {/* typography: off-scale — emoji hero sized via text-3xl */}
        <span className="text-3xl" role="img" aria-label="seedling">
          🌱
        </span>
      </div>
      <h2 className="mt-8 text-title-medium text-[var(--content-default)]">
        Setting up your assistant&hellip;
      </h2>
      <p className="mt-3 text-center text-body-medium-lighter text-[var(--content-tertiary)] transition-opacity duration-500">
        {hint}
      </p>
      <div className="mt-6 h-1 w-32 overflow-hidden rounded-full bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]">
        <div
          className="h-full rounded-full bg-[var(--system-positive-strong)]"
          style={{
            animation: "indeterminate 1.5s ease-in-out infinite",
          }}
        />
      </div>
    </div>
  );
}
