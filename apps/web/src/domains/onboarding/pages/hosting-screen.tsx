import { Cloud, Laptop, Package } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { setPendingProviderKey } from "@/domains/onboarding/provider-key";
import { clearGatewayToken } from "@/lib/auth/gateway-session";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { useHasPlatformSession } from "@/stores/auth-store";
import { docsUrl, routes } from "@/utils/routes";

type HostingMode = "vellum-cloud" | "local" | "docker";

interface HostingOption {
  mode: HostingMode;
  label: string;
  subtitle: string;
  icon: ReactNode;
  disabled?: boolean;
  badge?: string;
}

const ICON_CLASS = "h-5 w-5 shrink-0 text-[var(--content-secondary)]";

function useHostingOptions(): HostingOption[] {
  const hasPlatformSession = useHasPlatformSession();

  return [
    {
      mode: "vellum-cloud",
      label: "Vellum Cloud",
      subtitle:
        "Always on, 24/7, even when your computer is off. Runs on Vellum's secure infrastructure.",
      icon: <Cloud className={ICON_CLASS} />,
      ...(hasPlatformSession
        ? {}
        : { disabled: true, badge: "Requires Account" }),
    },
    {
      mode: "local",
      label: "Local",
      subtitle:
        "Runs directly on your machine. Your data never leaves your computer.",
      icon: <Laptop className={ICON_CLASS} />,
    },
    {
      mode: "docker",
      label: "Docker",
      subtitle:
        "Same privacy as local, but sandboxed using Docker for added isolation.",
      icon: <Package className={ICON_CLASS} />,
    },
  ];
}

export function HostingScreen() {
  const navigate = useNavigate();
  const hasPlatformSession = useHasPlatformSession();
  const options = useHostingOptions();
  const [selected, setSelected] = useState<HostingMode>(
    hasPlatformSession ? "vellum-cloud" : "local",
  );

  const onContinue = () => {
    if (selected === "vellum-cloud") {
      clearGatewayToken();
      setSelfHostedConnection(null);
      // Cloud is managed — drop any provider key staged from a prior
      // Local/Docker visit so it can't leak into a later local hatch.
      setPendingProviderKey(null);
      void navigate(routes.onboarding.privacy);
    } else {
      void navigate(`${routes.onboarding.apiKey}?hosting=${selected}`);
    }
  };

  const onBack = () => {
    void navigate(routes.onboarding.welcome);
  };

  return (
    <OnboardingLayout>
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center px-6 pb-40 pt-16 text-[var(--content-default)]">
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          Hosting
        </h1>
        <p
          className="mt-3 text-body-medium-lighter text-[var(--content-tertiary)]"
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          Where do you want your assistant to live?
        </p>

        <div
          className="mt-10 grid w-full auto-rows-fr gap-3"
          style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
        >
          {options.map((opt) => (
            <HostingCard
              key={opt.mode}
              option={opt}
              selected={selected === opt.mode}
              onSelect={() => {
                if (!opt.disabled) setSelected(opt.mode);
              }}
            />
          ))}
        </div>

        <div
          className="mt-8 flex w-full flex-col gap-2"
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            className="h-11 text-base"
            onClick={onContinue}
          >
            Continue
          </Button>
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            className="h-11 text-base"
            onClick={onBack}
          >
            Back
          </Button>
        </div>

        <a
          href={docsUrl(routes.docs.hostingOptions)}
          target="_blank"
          rel="noreferrer"
          className="mt-6 text-body-medium-default text-[var(--content-default)] underline"
          style={{ animation: "fadeInUp 0.5s ease-out 0.6s both" }}
        >
          Need help choosing?
        </a>
      </div>
    </OnboardingLayout>
  );
}

function HostingCard({
  option,
  selected,
  onSelect,
}: {
  option: HostingOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={option.disabled}
      className={`flex w-full items-center gap-4 rounded-xl border px-4 py-4 text-left transition-colors ${
        option.disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer"
      } ${
        selected && !option.disabled
          ? "border-[var(--primary-base)] bg-[var(--primary-base)]/5"
          : "border-[var(--border-element)] bg-transparent"
      }`}
    >
      {option.icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-body-medium-default text-[var(--content-default)]">
            {option.label}
          </span>
          {option.badge && (
            <span className="rounded-full bg-[var(--surface-tertiary)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
              {option.badge}
            </span>
          )}
        </div>
        <span className="mt-0.5 line-clamp-2 text-body-small-default text-[var(--content-tertiary)]">
          {option.subtitle}
        </span>
      </div>
      {!option.disabled && (
        <div
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
            selected
              ? "border-[var(--primary-base)]"
              : "border-[var(--border-element)]"
          }`}
        >
          {selected && (
            <div className="h-1.5 w-1.5 rounded-full bg-[var(--primary-base)]" />
          )}
        </div>
      )}
    </button>
  );
}
