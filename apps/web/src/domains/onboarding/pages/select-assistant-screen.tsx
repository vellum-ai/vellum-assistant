import { Cloud, Laptop } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { selectPlatformAssistant } from "@/assistant/select-platform-assistant";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { isPlatformLocal } from "@/lib/auth/loopback-auth";
import { isLocalMode } from "@/lib/local-mode";
import { startAuthFlow } from "@/runtime/native-auth";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

const ICON_CLASS = "h-5 w-5 shrink-0 text-[var(--content-secondary)]";

function assistantLabel(a: ResolvedAssistant): string {
  if (a.name) return a.name;
  return a.isLocal ? "Local Assistant" : "Cloud Assistant";
}

function assistantSubtitle(a: ResolvedAssistant): string {
  return a.isLocal ? "Running locally on this device" : "Hosted on Vellum Cloud";
}

export function SelectAssistantScreen() {
  const navigate = useNavigate();
  const hasPlatformSession = useHasPlatformSession();
  const assistants = useResolvedAssistantsStore.use.assistants();

  const isAccessible = (a: ResolvedAssistant): boolean =>
    a.isLocal || hasPlatformSession;

  const accessibleAssistants = assistants.filter(isAccessible);

  const hasPlatformAssistants = assistants.some((a) => !a.isLocal);
  const showLogin = hasPlatformAssistants && !hasPlatformSession;

  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [autoSkipping, setAutoSkipping] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loginFlowIdRef = useRef(0);

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
      }
      void navigate(routes.assistant, { replace: true });
    } catch {
      setError("Failed to connect. Please try again.");
      setConnecting(false);
    }
  };

  // Auto-skip when there's exactly one assistant and it's accessible.
  // Don't skip when inaccessible assistants exist — the user may want to log in.
  useEffect(() => {
    if (assistants.length === 0) return;
    if (assistants.length === 1 && accessibleAssistants.length === 1) {
      setAutoSkipping(true);
      void handleConnect(accessibleAssistants[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onContinue = () => {
    const assistant = assistants.find((a) => a.id === selected);
    if (assistant) void handleConnect(assistant);
  };

  const onBack = () => {
    void navigate(routes.onboarding.welcome);
  };

  const handleLogin = async () => {
    const returnTo = routes.onboarding.selectAssistant;

    if (isLocalMode() && isPlatformLocal()) {
      void navigate(`${routes.account.login}?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    const flowId = ++loginFlowIdRef.current;
    setError(null);
    setLoginLoading(true);
    try {
      const callbackUrl = `${routes.account.providerCallback}?returnTo=${encodeURIComponent(returnTo)}`;
      await startAuthFlow("workos-oidc", callbackUrl, { returnTo });
    } catch {
      if (flowId !== loginFlowIdRef.current) return;
      setError("Something went wrong. Please try again.");
      setLoginLoading(false);
    }
  };

  // Loading state during auto-skip
  if (autoSkipping && !error) {
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

        {error && (
          <p className="mt-4 text-body-small-default text-[var(--system-negative-strong)]">
            {error}
          </p>
        )}

        <div
          className="mt-10 grid w-full auto-rows-fr gap-3"
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
                badge={!accessible && !assistant.isLocal ? "Requires Account" : undefined}
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
          {showLogin && (
            <Button
              variant="outlined"
              size="regular"
              fullWidth
              className="h-11 text-base"
              onClick={() => void handleLogin()}
              disabled={connecting || loginLoading}
            >
              {loginLoading ? "Logging in…" : "Log In"}
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
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`flex w-full items-center gap-4 rounded-xl border px-4 py-4 text-left transition-colors ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      } ${
        selected && !disabled
          ? "border-[var(--primary-base)] bg-[var(--primary-base)]/5"
          : "border-[var(--border-element)] bg-transparent"
      }`}
    >
      {assistant.isLocal ? (
        <Laptop className={ICON_CLASS} />
      ) : (
        <Cloud className={ICON_CLASS} />
      )}
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
        <span className="mt-0.5 line-clamp-2 text-body-small-default text-[var(--content-tertiary)]">
          {assistantSubtitle(assistant)}
        </span>
      </div>
      {!disabled && (
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
