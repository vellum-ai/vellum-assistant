import { Check, Cloud, Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { resolveSelectedAssistantId } from "@/assistant/selection";
import { retireAssistant } from "@/assistant/retire-service";
import {
  clearGatewayToken,
  isRepairableGatewayTokenError,
} from "@/lib/auth/gateway-session";
import { isGuardianRepairable } from "@/lib/local-mode";
import { ConnectRecoveryDialog } from "@/domains/onboarding/components/connect-recovery-dialog";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { formatRelativeDate } from "@/utils/format-date";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { isElectron } from "@/runtime/is-electron";
import {
  requiresGuardianReprovision,
  wakeLocalAssistantHost,
} from "@/runtime/local-mode-host";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
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
  const electron = isElectron();
  const hasPlatformSession = useHasPlatformSession();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const currentOrganizationId =
    useOrganizationStore.use.currentOrganizationId();
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
  // A local assistant whose guardian token is missing/unrefreshable; opens
  // the recovery dialog instead of the generic connect error.
  const [recoveryAssistant, setRecoveryAssistant] =
    useState<ResolvedAssistant | null>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  // Default selection: the app's known selected assistant when accessible,
  // else the first accessible assistant.
  useEffect(() => {
    if (selected != null || accessibleAssistants.length === 0) return;
    const resolved = resolveSelectedAssistantId(currentOrganizationId);
    const match = accessibleAssistants.find((a) => a.id === resolved);
    setSelected(match?.id ?? accessibleAssistants[0].id);
  }, [selected, accessibleAssistants, currentOrganizationId]);

  const handleConnect = async (assistant: ResolvedAssistant) => {
    setConnecting(true);
    setError(null);
    try {
      if (assistant.isLocal) {
        await useAuthStore.getState().connectLocalAssistant(assistant.id);
      } else {
        await useAuthStore.getState().connectPlatformAssistant(assistant.id);
      }
      void navigate(routes.assistant, { replace: true });
    } catch (err) {
      console.error("selectAssistant.handleConnect failed", err);
      // Offer recovery when a guardian re-provision can fix it: the token is
      // gone/unrefreshable on disk, or the gateway rejected it at the
      // /auth/token mint (a 401 from a signing-key mismatch). Otherwise keep
      // the generic message — repair can't help.
      if (
        assistant.isLocal &&
        (requiresGuardianReprovision(err) ||
          isRepairableGatewayTokenError(err)) &&
        isGuardianRepairable(assistant.id)
      ) {
        setRecoveryAssistant(assistant);
      } else {
        setError("Failed to connect. Please try again.");
      }
      setConnecting(false);
    }
  };

  const clearRecoveryState = () => {
    setRecoveryAssistant(null);
    setRecoveryPending(false);
    setRecoveryError(null);
    // If recovery interrupted an auto-skip, dismissing it must land on the
    // chooser — leaving autoSkipping set would re-render the indefinite
    // "Connecting…" screen with no way out.
    setAutoSkipping(false);
  };

  const handleRecoveryRepair = async () => {
    // recoveryPending also guards re-entry: a second click can land before
    // React flushes the pending state into the dialog's disabled buttons.
    if (!recoveryAssistant || recoveryPending) return;
    setRecoveryPending(true);
    setRecoveryError(null);
    // try/catch, not just the result branch: a thrown fetch/transport error
    // would otherwise strand recoveryPending=true on a deliberately
    // un-dismissable pending dialog.
    try {
      const result = await wakeLocalAssistantHost(recoveryAssistant.id, {
        repairGuardian: true,
      });
      if (result.ok) {
        // Re-provisioning the guardian token revokes the gateway session
        // token derived from the old one. The cached token is still valid by
        // its local expiry, so `ensureGatewayToken` on reconnect would reuse
        // it and every gateway call would 401 — drop it so the reconnect mints
        // a fresh one against the new guardian principal.
        clearGatewayToken();
        clearRecoveryState();
        void handleConnect(recoveryAssistant);
        return;
      }
      setRecoveryError(result.error || "Repair failed. Please try again.");
    } catch (err) {
      console.error("selectAssistant.recoveryRepair failed", err);
      setRecoveryError("Repair failed. Please try again.");
    }
    setRecoveryPending(false);
  };

  const handleRecoveryRetire = async () => {
    if (!recoveryAssistant || recoveryPending) return;
    setRecoveryPending(true);
    setRecoveryError(null);
    try {
      const outcome = await retireAssistant(recoveryAssistant.id);
      if (outcome.ok) {
        clearRecoveryState();
        void navigate(outcome.nextRoute, { replace: true });
        return;
      }
      setRecoveryError(outcome.error);
    } catch (err) {
      console.error("selectAssistant.recoveryRetire failed", err);
      setRecoveryError("Failed to retire assistant. Please try again.");
    }
    setRecoveryPending(false);
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

  // Loading state during auto-skip. A pending recovery falls through to the
  // chooser so the dialog can render.
  if (autoSkipping && !displayError && !recoveryAssistant) {
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
      <div className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "min-h-screen px-6 pb-40 pt-16"} text-[var(--content-default)]`}>
        <h1
          className={electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          Choose an Assistant
        </h1>
        <p
          className={`text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-3"}`}
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
          className={`flex w-full flex-col ${electron ? "mt-8 gap-2" : "mt-10 gap-3"}`}
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
          className={`mt-8 flex w-full flex-col ${electron ? "gap-2.5" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          {accessibleAssistants.length > 0 && (
            <Button
              variant="primary"
              size="regular"
              fullWidth
              className={electron ? undefined : "h-11 text-base"}
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
            className={electron ? undefined : "h-11 text-base"}
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
              className={electron ? undefined : "h-11 text-base"}
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
            className={electron ? undefined : "h-11 text-base"}
            onClick={onBack}
            disabled={connecting || loginLoading}
          >
            Back
          </Button>
        </div>
      </div>
      <ConnectRecoveryDialog
        open={recoveryAssistant != null}
        assistantName={recoveryAssistant ? assistantLabel(recoveryAssistant) : ""}
        isPending={recoveryPending}
        errorMessage={recoveryError ?? undefined}
        onCancel={clearRecoveryState}
        onRepair={() => void handleRecoveryRepair()}
        onRetire={() => void handleRecoveryRetire()}
      />
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
  // Electron compacts the card to the Swift client's onboarding-card metrics
  // (12px padding, 12px radius, 12px icon→text gap, 11px secondary text) so
  // the picker reads at the same density as the native windows.
  const electron = isElectron();

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={[
        "group flex w-full items-center border text-left",
        electron ? "gap-3 rounded-lg p-3" : "gap-4 rounded-2xl px-5 py-4",
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
          "flex shrink-0 items-center justify-center transition-colors duration-200",
          electron ? "h-8 w-8 rounded-lg" : "h-10 w-10 rounded-xl",
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
            <span className={`rounded-full bg-[var(--surface-tertiary)] px-2 py-0.5 text-[var(--content-tertiary)] ${electron ? "text-label-medium-default" : "text-body-small-default"}`}>
              {badge}
            </span>
          )}
        </div>
        {subtitle && (
          <span className={`mt-0.5 block text-[var(--content-tertiary)] ${electron ? "text-label-medium-default" : "text-body-small-default"}`}>
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
