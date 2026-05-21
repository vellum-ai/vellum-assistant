
import { type ReactNode, useEffect, useState } from "react";

import { useHintRotation } from "@/domains/chat/hooks/use-hint-rotation.js";

const CLEANUP_HINTS = [
  "Cleaning up your assistant\u2026",
  "Wrapping things up\u2026",
  "Almost done\u2026",
] as const;
const HINT_INTERVAL_MS = 4000;
const CLEANUP_TIMEOUT_MS = 120_000;

function CleanupLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full flex-col items-center justify-center px-4 py-24">
      {children}
    </div>
  );
}

export function CleanupScreen() {
  const hint = useHintRotation(CLEANUP_HINTS, HINT_INTERVAL_MS);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setTimedOut(true), CLEANUP_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, []);

  if (timedOut) {
    return (
      <CleanupLayout>
        <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--system-mid-weak)]">
          {/* typography: off-scale — emoji hero sized via text-3xl */}
          <span className="text-3xl" role="img" aria-label="warning">
            &#x26A0;&#xFE0F;
          </span>
        </div>
        <h2 className="mt-8 text-title-medium text-[var(--content-default)]">
          Cleanup is taking longer than expected
        </h2>
        <p className="mt-3 max-w-md text-center text-body-medium-lighter text-[var(--content-tertiary)]">
          Please reach out to{" "}
          <a
            href="mailto:support@vellum.ai"
            className="text-body-medium-default underline text-[var(--system-positive-strong)] hover:opacity-90"
          >
            Vellum Support
          </a>{" "}
          for help on how to hatch a new assistant.
        </p>
      </CleanupLayout>
    );
  }

  return (
    <CleanupLayout>
      <div
        className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--surface-lift)] dark:bg-[var(--surface-lift)]"
        style={{ animation: "fadeInUp 0.5s ease-out forwards" }}
      >
        {/* typography: off-scale — emoji hero sized via text-3xl */}
        <span className="text-3xl" role="img" aria-label="broom">
          🧹
        </span>
      </div>
      <h2 className="mt-8 text-title-medium text-[var(--content-default)]">
        Cleaning up your assistant&hellip;
      </h2>
      <p className="mt-3 max-w-md text-center text-body-medium-lighter text-[var(--content-tertiary)] transition-opacity duration-500">
        {hint}
      </p>
      <p className="mt-2 max-w-md text-center text-body-medium-lighter text-[var(--content-tertiary)]">
        You&apos;ll be able to hatch a new assistant once this is complete.
      </p>
      <div className="mt-6 h-1 w-32 overflow-hidden rounded-full bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]">
        <div
          className="h-full rounded-full bg-[var(--content-tertiary)]"
          style={{
            animation: "indeterminate 1.5s ease-in-out infinite",
          }}
        />
      </div>
    </CleanupLayout>
  );
}
