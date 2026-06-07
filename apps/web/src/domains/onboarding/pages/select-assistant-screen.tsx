import { Cloud, Laptop } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { selectPlatformAssistant } from "@/assistant/select-platform-assistant";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
  isLocalAssistant,
  isPlatformAssistant,
  type LockfileAssistant,
} from "@/lib/local-mode";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import { useLockfileStore } from "@/stores/lockfile-store";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

const ICON_CLASS = "h-5 w-5 shrink-0 text-[var(--content-secondary)]";

function assistantLabel(a: LockfileAssistant): string {
  if (a.name) return a.name;
  return isPlatformAssistant(a) ? "Cloud Assistant" : "Local Assistant";
}

function assistantSubtitle(a: LockfileAssistant): string {
  if (isPlatformAssistant(a)) return "Hosted on Vellum Cloud";
  return "Running locally on this device";
}

export function SelectAssistantScreen() {
  const navigate = useNavigate();
  const hasPlatformSession = useHasPlatformSession();
  const lockfile = useLockfileStore.use.lockfile();
  const assistants = lockfile?.assistants ?? [];

  const isAccessible = (a: LockfileAssistant): boolean =>
    isLocalAssistant(a) || (isPlatformAssistant(a) && hasPlatformSession);

  const accessibleAssistants = assistants.filter(isAccessible);

  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSkipAttempted = useRef(false);

  // Default selection to first accessible assistant
  useEffect(() => {
    if (selected == null && accessibleAssistants.length > 0) {
      setSelected(accessibleAssistants[0].assistantId);
    }
  }, [selected, accessibleAssistants]);

  const handleConnect = async (assistant: LockfileAssistant) => {
    setConnecting(true);
    setError(null);
    try {
      if (isLocalAssistant(assistant)) {
        await useAuthStore.getState().connectLocalAssistant(assistant.assistantId);
      } else {
        await selectPlatformAssistant(assistant.assistantId);
      }
      void navigate(routes.assistant, { replace: true });
    } catch {
      setError("Failed to connect. Please try again.");
      setConnecting(false);
    }
  };

  // Redirect to hosting if no assistants in lockfile
  useEffect(() => {
    if (assistants.length === 0) {
      void navigate(routes.onboarding.hosting, { replace: true });
    }
  }, [assistants.length, navigate]);

  // Auto-skip when exactly one accessible assistant
  useEffect(() => {
    if (autoSkipAttempted.current || assistants.length === 0) return;
    autoSkipAttempted.current = true;

    if (accessibleAssistants.length === 1) {
      void handleConnect(accessibleAssistants[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onContinue = () => {
    const assistant = assistants.find((a) => a.assistantId === selected);
    if (assistant) void handleConnect(assistant);
  };

  const onBack = () => {
    void navigate(routes.onboarding.welcome);
  };

  // Loading state during auto-skip
  if (connecting && autoSkipAttempted.current && accessibleAssistants.length <= 1) {
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
            const isPlatform = isPlatformAssistant(assistant);
            return (
              <AssistantCard
                key={assistant.assistantId}
                assistant={assistant}
                selected={selected === assistant.assistantId}
                disabled={!accessible}
                badge={!accessible && isPlatform ? "Requires Account" : undefined}
                onSelect={() => {
                  if (accessible) setSelected(assistant.assistantId);
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
            onClick={onBack}
            disabled={connecting}
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
  assistant: LockfileAssistant;
  selected: boolean;
  disabled: boolean;
  badge?: string;
  onSelect: () => void;
}) {
  const isPlatform = isPlatformAssistant(assistant);
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
      {isPlatform ? <Cloud className={ICON_CLASS} /> : <Laptop className={ICON_CLASS} />}
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
