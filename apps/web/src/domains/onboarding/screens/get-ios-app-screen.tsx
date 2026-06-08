import { Check } from "lucide-react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
    openIOSAppStore,
    writeIOSAppDownloaded,
} from "@/hooks/use-ios-app-nudge";
import { Button } from "@vellumai/design-library/components/button";

interface GetIOSAppScreenProps {
  onComplete: () => void;
}

const FEATURES = [
  { label: "Push notifications", detail: "stay in the loop even when the browser is closed" },
  { label: "Biometric login", detail: "Face ID & Touch ID for instant, secure access" },
  { label: "Native haptics", detail: "tactile feedback that feels part of the device" },
  { label: "Home screen access", detail: "launch your assistant with a single tap" },
];

export function GetIOSAppScreen({ onComplete }: GetIOSAppScreenProps) {
  function handleDownload() {
    writeIOSAppDownloaded();
    openIOSAppStore();
    onComplete();
  }

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-6 pb-40 text-center">
        <div
          className="mb-8 flex size-16 items-center justify-center rounded-2xl border"
          style={{
            background: "var(--surface-overlay)",
            borderColor: "var(--border-element)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)",
            animation: "fadeInUp 0.3s ease-out both",
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "var(--content-default)" }}
            aria-hidden
          >
            <rect x="5" y="2" width="14" height="20" rx="3" />
            <line x1="12" y1="18" x2="12" y2="18.01" />
          </svg>
        </div>

        <p
          className="text-label-small-default mb-3 uppercase tracking-[0.2em]"
          style={{
            color: "var(--content-tertiary)",
            animation: "fadeInUp 0.3s ease-out 0.05s both",
          }}
        >
          One more thing
        </p>

        <h1
          className="mb-3 text-3xl font-semibold tracking-tight"
          style={{
            color: "var(--content-default)",
            animation: "fadeInUp 0.3s ease-out 0.1s both",
          }}
        >
          Your assistant, in your pocket.
        </h1>

        <p
          className="text-body-medium-lighter mb-10 max-w-sm"
          style={{
            color: "var(--content-secondary)",
            animation: "fadeInUp 0.3s ease-out 0.15s both",
          }}
        >
          The iOS app keeps your assistant a tap away — with push
          notifications, biometric login, and native haptics.
        </p>

        <div
          className="mb-10 w-full rounded-xl border px-5 py-4"
          style={{
            background: "var(--surface-overlay)",
            borderColor: "var(--border-element)",
            animation: "fadeInUp 0.3s ease-out 0.2s both",
          }}
        >
          <ul className="space-y-4">
            {FEATURES.map((feature, i) => (
              <li key={feature.label} className="flex items-start gap-3"
                style={{ animation: `fadeInUp 0.3s ease-out ${0.25 + i * 0.05}s both` }}
              >
                <span
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full"
                  style={{ background: "var(--system-positive-weak)" }}
                >
                  <Check
                    size={12}
                    style={{ color: "var(--system-positive-strong)" }}
                  />
                </span>
                <span className="text-left">
                  <span
                    className="text-body-medium-default"
                    style={{ color: "var(--content-default)" }}
                  >
                    {feature.label}
                  </span>
                  <span
                    className="text-body-medium-lighter"
                    style={{ color: "var(--content-tertiary)" }}
                  >
                    {" — "}{feature.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div
          className="flex w-full flex-col gap-2"
          style={{ animation: "fadeInUp 0.3s ease-out 0.45s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            onClick={handleDownload}
            className="h-11 text-base"
          >
            Download on the App Store
          </Button>

          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onComplete}
            className="h-11 text-base"
          >
            Continue in browser
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
