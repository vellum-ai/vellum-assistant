import { ArrowLeft, Check, Cloud, Laptop } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { OnboardingLayout } from "@/components/onboarding-layout";
import { handleRadioCardArrowNav } from "@/domains/onboarding/components/radio-card-nav";
import { SETUP_NAVIGATE } from "@/domains/onboarding/onboarding-navigation";
import { setPendingProviderKey } from "@/domains/onboarding/provider-key";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { clearGatewayToken } from "@/lib/auth/gateway-session";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { isElectron } from "@/runtime/is-electron";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useTranslation } from "@/i18n";
import { docsUrl, routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

type HostingMode = "vellum-cloud" | "local" | "docker";

interface HostingOption {
  mode: HostingMode;
  label: string;
  subtitle: string;
  icon: ReactNode;
  disabled?: boolean;
  badge?: string;
}

const ICON_CLASS = "h-5 w-5 shrink-0";

function useHostingOptions(): HostingOption[] {
  const hasPlatformSession = useHasPlatformSession();
  const multiPlatformAssistant =
    useClientFeatureFlagStore.use.multiPlatformAssistant();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const hasPlatformAssistant = assistants.some((a) => a.isPlatformHosted);

  const cloudDisabled =
    !hasPlatformSession || (!multiPlatformAssistant && hasPlatformAssistant);

  return [
    {
      mode: "vellum-cloud",
      label: "Vellum Cloud",
      subtitle:
        "Always on, 24/7, even when your computer is off. Runs on Vellum's secure infrastructure.",
      icon: <Cloud className={ICON_CLASS} />,
      ...(cloudDisabled
        ? {
            disabled: true,
            badge: hasPlatformSession ? "Limit Reached" : "Requires Account",
          }
        : {}),
    },
    {
      mode: "local",
      label: "Local",
      subtitle:
        "Runs directly on your machine. Your data never leaves your computer.",
      icon: <Laptop className={ICON_CLASS} />,
    },
  ];
}

export function HostingScreen() {
  const { t } = useTranslation("onboarding");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fromSelectAssistant = searchParams.get("from") === "select-assistant";
  const hasPlatformSession = useHasPlatformSession();
  const electron = isElectron();
  const options = useHostingOptions();
  const cloudDisabled = options.find(
    (o) => o.mode === "vellum-cloud",
  )?.disabled;
  const [selected, setSelected] = useState<HostingMode>(
    hasPlatformSession && !cloudDisabled ? "vellum-cloud" : "local",
  );

  useEffect(() => {
    if (cloudDisabled && selected === "vellum-cloud") {
      setSelected("local");
    }
  }, [cloudDisabled, selected]);

  const {
    loading: loginLoading,
    error: loginError,
    login,
    cancel: cancelLogin,
  } = useOnboardingLogin(`${routes.onboarding.hosting}?from=select-assistant`);

  // Electron mirrors the Swift client's Hosting step, which has no login
  // affordance; its login lives on the wake-up step instead.
  const showLogin = fromSelectAssistant && !hasPlatformSession && !electron;

  const onContinue = () => {
    if (selected === "vellum-cloud") {
      clearGatewayToken();
      setSelfHostedConnection(null);
      // Cloud is managed: drop any provider key staged from a prior
      // Local/Docker visit so it can't leak into a later local hatch.
      setPendingProviderKey(null);
      void navigate(routes.onboarding.privacy, SETUP_NAVIGATE);
    } else {
      void navigate(
        `${routes.onboarding.apiKey}?hosting=${selected}`,
        SETUP_NAVIGATE,
      );
    }
  };

  const onBack = () => {
    void navigate(
      fromSelectAssistant ? routes.selectAssistant : routes.welcome,
      SETUP_NAVIGATE,
    );
  };

  return (
    <OnboardingLayout avatarWave="beside">
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "min-h-screen px-6 pb-40 pt-6 md:min-h-full md:pb-6"} text-[var(--content-default)]`}
      >
        {/* The main block floats in the space above the creature footer;
            electron keeps its compact top-aligned flow. */}
        <div
          className={`flex w-full flex-col items-center ${electron ? "" : "flex-1 justify-center"}`}
        >
        <h1
          className={
            electron
              ? "text-title-large"
              : "text-3xl font-semibold tracking-tight"
          }
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          {t("hostingScreen.title")}
        </h1>
        <p
          className={`text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-3"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          {t("hostingScreen.body")}{" "}
          <a
            href={docsUrl(routes.docs.hostingOptions)}
            target="_blank"
            rel="noreferrer"
            className="underline transition-colors hover:text-[var(--content-default)]"
          >
            {t("hostingScreen.needHelp")}
          </a>
        </p>

        {loginError && (
          <p className="mt-4 text-body-small-default text-[var(--system-negative-strong)]">
            {loginError}
          </p>
        )}

        <div
          role="radiogroup"
          aria-label={t("hostingScreen.optionsAriaLabel")}
          onKeyDown={handleRadioCardArrowNav}
          className={`grid w-full ${electron ? "mt-8 gap-2" : "auto-rows-fr mt-10 gap-3"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
        >
          {options.map((opt) => (
            <HostingCard
              key={opt.mode}
              option={opt}
              selected={selected === opt.mode}
              tabStop={selected === opt.mode}
              onSelect={() => {
                if (!opt.disabled) {
                  setSelected(opt.mode);
                }
              }}
              loginLabel={
                loginLoading ? t("actions.cancel") : t("actions.loginToUse")
              }
              onLogin={
                opt.disabled && opt.mode === "vellum-cloud" && showLogin
                  ? loginLoading
                    ? cancelLogin
                    : () => void login()
                  : undefined
              }
            />
          ))}
        </div>

        <div
          className="mt-8 w-full"
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            className={electron ? undefined : "h-11 text-base"}
            onClick={onContinue}
          >
            {t("actions.continue")}
          </Button>
        </div>
        <div
          className="mt-3"
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Button
            variant="ghost"
            size="compact"
            className="text-[var(--content-tertiary)]"
            leftIcon={<ArrowLeft />}
            onClick={onBack}
            disabled={loginLoading}
          >
            {t("actions.back")}
          </Button>
        </div>

        </div>
      </div>
    </OnboardingLayout>
  );
}

function HostingCard({
  option,
  selected,
  tabStop,
  onSelect,
  loginLabel,
  onLogin,
}: {
  option: HostingOption;
  selected: boolean;
  /** The radiogroup's single roving tab stop lands on this card. */
  tabStop: boolean;
  onSelect: () => void;
  loginLabel: string;
  /** Present on the locked cloud card when logging in can unlock it. */
  onLogin?: () => void;
}) {
  // Electron compacts the card to the Swift client's hosting-card metrics
  // (APIKeyStepView.swift): 72px fixed height, 12px padding, 12px radius,
  // 12px icon→text gap, 11px description.
  const electron = isElectron();
  const locked = !!option.disabled;
  // The badge explains a lock nothing on this card can lift (e.g. Limit
  // Reached); when logging in unlocks the card, the login button replaces it.
  const badge = onLogin ? undefined : option.badge;

  return (
    <div
      role={locked ? undefined : "radio"}
      aria-checked={locked ? undefined : selected}
      tabIndex={locked ? undefined : tabStop ? 0 : -1}
      onClick={locked ? undefined : onSelect}
      onKeyDown={
        locked
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
      }
      className={[
        "group flex w-full items-center border text-left",
        electron
          ? "h-[72px] gap-3 rounded-lg p-3"
          : "gap-4 rounded-2xl px-5 py-4",
        "transition-all duration-200 ease-out",
        locked
          ? "border-[var(--border-base)] bg-[var(--surface-overlay)]"
          : "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-base)]",
        locked
          ? ""
          : selected
            ? "border-[var(--primary-base)] bg-[var(--surface-lift)]"
            : "border-[var(--border-base)] bg-[var(--surface-lift)]/60 hover:border-[var(--border-element)] hover:bg-[var(--surface-lift)]",
      ].join(" ")}
    >
      <div
        className={[
          "flex shrink-0 items-center justify-center transition-colors duration-200",
          electron ? "h-8 w-8 rounded-md" : "h-10 w-10 rounded-md",
          selected && !locked
            ? "bg-[var(--primary-base)] text-[var(--surface-base)]"
            : "bg-[var(--surface-active)]/40 text-[var(--content-secondary)]",
        ].join(" ")}
      >
        {option.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-body-medium-default text-[var(--content-default)]">
            {option.label}
          </span>
          {badge && (
            <span
              className={`rounded-full bg-[var(--surface-active)]/40 px-2 py-0.5 text-[var(--content-tertiary)] ${electron ? "text-label-medium-default" : "text-body-small-default"}`}
            >
              {badge}
            </span>
          )}
        </div>
        <span
          className={`mt-1 line-clamp-2 text-[var(--content-tertiary)] ${electron ? "text-label-medium-default leading-[14px]" : "text-body-small-default"}`}
        >
          {option.subtitle}
        </span>
      </div>
      {onLogin && (
        <Button
          variant="primary"
          size="regular"
          className="shrink-0"
          onClick={onLogin}
        >
          {loginLabel}
        </Button>
      )}
      {!locked && (
        <div
          className={[
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200",
            selected
              ? "border-[var(--primary-base)] bg-[var(--primary-base)]"
              : "border-[var(--border-element)] group-hover:border-[var(--content-tertiary)]",
          ].join(" ")}
        >
          {selected && (
            <Check
              className="h-3 w-3 text-[var(--surface-base)]"
              strokeWidth={3}
            />
          )}
        </div>
      )}
    </div>
  );
}
