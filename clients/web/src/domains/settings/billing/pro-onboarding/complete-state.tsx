import { ArrowLeft, PartyPopper } from "lucide-react";

import { useNavigate } from "react-router";

import { useQuery } from "@tanstack/react-query";

import { assistantsActiveRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

export function CompleteState({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const { data: activeAssistant } = useQuery(assistantsActiveRetrieveOptions());
  const assistantName = activeAssistant?.name || "your assistant";

  return (
    <div className="relative flex min-h-[320px] flex-col items-center justify-center overflow-hidden px-8 text-center">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 38%, color-mix(in oklab, var(--system-positive-strong) 14%, transparent), transparent)",
        }}
        aria-hidden="true"
      />

      <div
        className="relative mb-5 flex items-center justify-center"
        style={{ animation: "welcome-reveal 600ms ease-out both" }}
      >
        <div
          className="absolute h-24 w-24 rounded-full"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklab, var(--system-positive-strong) 18%, transparent), transparent 70%)",
            animation: "welcome-crown-glow 3s ease-in-out infinite",
          }}
          aria-hidden="true"
        />
        <div
          className="absolute h-16 w-16 rounded-full"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklab, var(--system-positive-strong) 12%, transparent), transparent 70%)",
            animation: "welcome-crown-glow 3s ease-in-out infinite 0.5s",
          }}
          aria-hidden="true"
        />
        <PartyPopper
          className="relative h-8 w-8 text-[var(--system-positive-strong)]"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </div>

      <h1
        className="relative mb-2 text-[var(--content-emphasised)]"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: "28px",
          lineHeight: 1,
          fontWeight: 400,
          animation: "welcome-reveal 600ms ease-out 150ms both",
        }}
      >
        You&apos;re all set
      </h1>

      <p
        className="relative mb-6 max-w-[320px] text-body-medium-lighter text-[var(--content-secondary)]"
        style={{ animation: "welcome-reveal 600ms ease-out 300ms both" }}
      >
        Your assistant just got a serious upgrade.
      </p>

      <div style={{ animation: "welcome-reveal 600ms ease-out 450ms both" }}>
        <Button
          variant="primary"
          data-testid="onboarding-complete-return"
          onClick={() => navigate(routes.assistant, { replace: true })}
        >
          Return to {assistantName}
        </Button>
      </div>

      <div className="absolute bottom-4 left-4">
        <Button
          variant="ghost"
          data-testid="onboarding-complete-back"
          onClick={onBack}
          leftIcon={<ArrowLeft className="h-4 w-4" />}
        >
          Back
        </Button>
      </div>
    </div>
  );
}
