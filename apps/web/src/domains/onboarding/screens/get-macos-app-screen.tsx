import { Check } from "lucide-react";

import { Button } from "@vellum/design-library/components/button";
import { AppleLogo } from "@/components/icons/apple-logo";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
  writeMacOsAppDownloaded,
  openMacOsDownload,
} from "@/hooks/use-macos-app-nudge";

interface GetMacOSAppScreenProps {
  onComplete: () => void;
}

const FEATURES = [
  { label: "Computer use", detail: "control your screen and automate any app" },
  { label: "Run commands", detail: "execute bash directly on your machine" },
  { label: "macOS automation", detail: "script native apps like Mail, Calendar & more" },
  { label: "Global hotkey", detail: "summon your assistant from anywhere" },
];

export function GetMacOSAppScreen({ onComplete }: GetMacOSAppScreenProps) {
  function handleDownload() {
    writeMacOsAppDownloaded();
    openMacOsDownload();
    onComplete();
  }

  return (
    <OnboardingLayout>
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
          <AppleLogo
            size={28}
            style={{ color: "var(--content-default)" }}
          />
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

        {/* typography: off-scale — hero onboarding h1 (30px) larger than text-title-large (24px) to match macOS visual weight */}
        <h1
          className="mb-3 text-3xl font-semibold tracking-tight"
          style={{
            color: "var(--content-default)",
            animation: "fadeInUp 0.3s ease-out 0.1s both",
          }}
        >
          Faster, quieter, native.
        </h1>

        <p
          className="text-body-medium-lighter mb-10 max-w-sm"
          style={{
            color: "var(--content-secondary)",
            animation: "fadeInUp 0.3s ease-out 0.15s both",
          }}
        >
          The macOS app unlocks your assistant&apos;s full potential —
          computer use, terminal access, and native automation.
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
            Download for macOS
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
