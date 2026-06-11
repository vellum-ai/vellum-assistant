import { Check, Cloud, Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { selectPlatformAssistant } from "@/assistant/select-platform-assistant";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { formatRelativeDate } from "@/utils/format-date";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

function assistantLabel(a: ResolvedAssistant): string {
  if (a.name) return a.name;
  return a.isLocal ? "Local Assistant" : "Cloud Assistant";
}

function assistantSubtitle(a: ResolvedAssistant): string | undefined {
  if (!a.hatchedAt) return undefined;
  return `Created ${formatRelativeDate(a.hatchedAt)}`;
}

export function SelectAssistantScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fromLogin = searchParams.get("fromLogin") === "1";
  const fromSettings = searchParams.get("fromSettings") === "1";
  const hasPlatformSession = useHasPlatformSession();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const {
    loading: loginLoading,
    error: loginError,
    login,
    cancel: cancelLogin,
  } = useOnboardingLogin();

  const isAccessible = (a: ResolvedAssistant): boolean =>
    a.isLocal || hasPlatformSession;

  const accessibleAssistants = assistants.filter(isAccessible);

  const hasPlatformAssistants = assistants.some((a) => a.isPlatformHosted);
  const showLogin = hasPlatformAssistants && !hasPlatformSession;

  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [autoSkipping, setAutoSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default selection to first accessible assistant
  useEffect(() => {
    if (selected == null && accessibleAssistants.length > 0) {
      setSelected(accessibleAssistants[0].id);
    }
  }, [selected, accessibleAssistants]);

  const handleConnect = async (assistant: ResolvedAssistant) => {
    setConnecting(true);
    setError(null);
    try {
      if (assistant.isLocal) {
        await useAuthStore.getState().connectLocalAssistant(assistant.id);
      } else {
        await selectPlatformAssistant(assistant.id);
        await useAuthStore.getState().connectPlatformAssistant(assistant.id);
      }
      void navigate(routes.assistant, { replace: true });
    } catch {
      setError("Failed to connect. Please try again.");
      setConnecting(false);
    }
  };

  // Auto-skip when there's exactly one assistant and it's accessible.
  // Don't skip when the user just logged in or navigated here deliberately
  // from settings — let them see the chooser.
  // Reactive to assistants so it fires when the store populates after mount.
  useEffect(() => {
    if (fromLogin || fromSettings) return;
    if (connecting || autoSkipping) return;
    if (assistants.length === 0) return;
    if (assistants.length === 1 && accessibleAssistants.length === 1) {
      setAutoSkipping(true);
      void handleConnect(accessibleAssistants[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistants.length, accessibleAssistants.length]);

  const onContinue = () => {
    const assistant = assistants.find((a) => a.id === selected);
    if (assistant) void handleConnect(assistant);
  };

  const onBack = () => {
    void navigate(routes.welcome);
  };

  const displayError = loginError ?? error;

  // Loading state during auto-skip
  if (autoSkipping && !displayError) {
    return (
      <OnboardingLayout>
        <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-6 text-[var(--content-default)]">
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            Connecting to your assistant…
          </p>
        </div>
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout>
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center px-6 pb-40 pt-16 text-[var(--content-default)]">
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          Choose an Assistant
        </h1>
        <p
          className="mt-3 text-body-medium-lighter text-[var(--content-tertiary)]"
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          Select which assistant you&rsquo;d like to use.
        </p>

        {displayError && (
          <p className="mt-4 text-body-small-default text-[var(--system-negative-strong)]">
            {displayError}
          </p>
        )}

        <div
          className="mt-10 flex w-full flex-col gap-3"
          style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
        >
          {assistants.map((assistant) => {
            const accessible = isAccessible(assistant);
            return (
              <AssistantCard
                key={assistant.id}
                assistant={assistant}
                selected={selected === assistant.id}
                disabled={!accessible}
                badge={!accessible && assistant.isPlatformHosted ? "Requires Account" : undefined}
                onSelect={() => {
                  if (accessible) setSelected(assistant.id);
                }}
              />
            );
          })}
        </div>

        <div
          className="mt-8 flex w-full flex-col gap-2"
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          {accessibleAssistants.length > 0 && (
            <Button
              variant="primary"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={onContinue}
              disabled={!selected || connecting}
            >
              {connecting ? "Connecting…" : "Continue"}
            </Button>
          )}
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            className="h-11 text-base"
            onClick={() =>
              void navigate(
                `${routes.onboarding.hosting}?from=select-assistant`,
              )
            }
            disabled={connecting || loginLoading}
          >
            Create New Assistant
          </Button>
          {showLogin && (
            <Button
              variant="outlined"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={loginLoading ? cancelLogin : () => void login()}
              disabled={connecting}
            >
              {loginLoading ? "Cancel" : "Log In"}
            </Button>
          )}
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            className="h-11 text-base"
            onClick={onBack}
            disabled={connecting || loginLoading}
          >
            Back
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}

function AssistantCard({
  assistant,
  selected,
  disabled,
  badge,
  onSelect,
}: {
  assistant: ResolvedAssistant;
  selected: boolean;
  disabled: boolean;
  badge?: string;
  onSelect: () => void;
}) {
  const subtitle = assistantSubtitle(assistant);

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={[
        "group flex w-full items-center gap-4 rounded-2xl border px-5 py-4 text-left",
        "transition-all duration-200 ease-out",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:bg-[var(--surface-secondary)]",
        selected && !disabled
          ? "border-[var(--primary-base)] bg-[var(--primary-base)]/[0.08] shadow-[inset_0_0_0_1px_var(--primary-base)]"
          : "border-[var(--border-element)] bg-transparent",
      ].join(" ")}
    >
      <div
        className={[
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-200",
          selected && !disabled
            ? "bg-[var(--primary-base)]/15 text-[var(--primary-base)]"
            : "bg-[var(--surface-tertiary)] text-[var(--content-secondary)]",
        ].join(" ")}
      >
        {assistant.isLocal ? (
          <Laptop className="h-5 w-5" />
        ) : (
          <Cloud className="h-5 w-5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-body-medium-default text-[var(--content-default)]">
            {assistantLabel(assistant)}
          </span>
          {badge && (
            <span className="rounded-full bg-[var(--surface-tertiary)] px-2 py-0.5 text-body-small-default text-[var(--content-tertiary)]">
              {badge}
            </span>
          )}
        </div>
        {subtitle && (
          <span className="mt-0.5 block text-body-small-default text-[var(--content-tertiary)]">
            {subtitle}
          </span>
        )}
      </div>

      {!disabled && (
        <div
          className={[
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200",
            selected
              ? "border-[var(--primary-base)] bg-[var(--primary-base)]"
              : "border-[var(--border-element)] group-hover:border-[var(--content-tertiary)]",
          ].join(" ")}
        >
          {selected && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
        </div>
      )}
    </button>
  );
}
