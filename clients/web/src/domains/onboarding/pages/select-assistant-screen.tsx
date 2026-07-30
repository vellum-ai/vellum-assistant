import {
  ArrowLeft,
  Check,
  Cloud,
  EllipsisVertical,
  Laptop,
  Plus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { resolveSelectedAssistantId } from "@/assistant/selection";
import { retireAssistant } from "@/assistant/retire-service";
import {
  clearGatewayToken,
  isRepairableGatewayTokenError,
} from "@/lib/auth/gateway-session";
import {
  isCliWakeableAssistant,
  removePlatformAssistantFromLockfile,
  UnresolvedLocalGatewayError,
} from "@/lib/local-mode";
import { ConnectRecoveryDialog } from "@/domains/onboarding/components/connect-recovery-dialog";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { handleRadioCardArrowNav } from "@/domains/onboarding/components/radio-card-nav";
import { SessionCornerAction } from "@/domains/onboarding/components/session-corner-action";
import { formatRelativeDate } from "@/utils/format-date";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { isElectron } from "@/runtime/is-electron";
import {
  isLocalModeHostAvailable,
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
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Menu } from "@vellumai/design-library/components/menu";

function assistantLabel(a: ResolvedAssistant): string {
  if (a.name) {
    return a.name;
  }
  return a.isLocal ? "Local Assistant" : "Cloud Assistant";
}

function assistantSubtitle(a: ResolvedAssistant): string {
  const hosting = a.isLocal ? "On this computer" : "Cloud-hosted";
  if (!a.hatchedAt) {
    return hosting;
  }
  return `${hosting} · Created ${formatRelativeDate(a.hatchedAt)}`;
}

export function SelectAssistantScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fromLogin = searchParams.get("fromLogin") === "1";
  const noAutoSkip = searchParams.get("noAutoSkip") === "1";
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

  // A locked platform entry can be forgotten on this device (dropped from the
  // lockfile) only where a local-mode host can rewrite the lockfile.
  const canRemoveLockedAssistants =
    !hasPlatformSession && isLocalModeHostAvailable();

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
  // Target of the "Remove from this device" confirmation dialog.
  const [removeTarget, setRemoveTarget] = useState<ResolvedAssistant | null>(
    null,
  );
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // After a manual removal the user is mid-management on this screen: a
  // sudden auto-connect to the sole remaining assistant would be jarring, so
  // the auto-skip stands down for the rest of the visit.
  const removedThisVisitRef = useRef(false);

  // Default selection: the app's known selected assistant when accessible,
  // else the first accessible assistant. Also reconciles an existing
  // selection that stops being accessible (an in-place logout locks the
  // platform cards), so Continue can never target a locked assistant.
  useEffect(() => {
    if (accessibleAssistants.length === 0) {
      if (selected != null) {
        setSelected(null);
      }
      return;
    }
    if (
      selected != null &&
      accessibleAssistants.some((a) => a.id === selected)
    ) {
      return;
    }
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
      // Offer recovery only where wake can actually run: the assistant is local
      // and CLI-wakeable AND this runtime has a local-mode host (mirrors the
      // wake affordance gate in status-banner), and the failure is one a
      // guardian re-provision can fix (the token is gone/unrefreshable on disk,
      // the gateway rejected it at the /auth/token mint (a 401 from a signing-key
      // mismatch), or the local gateway is unresolved with no recorded port).
      // Otherwise keep the generic message; repair can't help.
      if (
        assistant.isLocal &&
        isLocalModeHostAvailable() &&
        (requiresGuardianReprovision(err) ||
          isRepairableGatewayTokenError(err) ||
          err instanceof UnresolvedLocalGatewayError) &&
        isCliWakeableAssistant(assistant.id)
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
    // chooser; leaving autoSkipping set would re-render the indefinite
    // "Connecting…" screen with no way out.
    setAutoSkipping(false);
  };

  const handleRecoveryRepair = async () => {
    // recoveryPending also guards re-entry: a second click can land before
    // React flushes the pending state into the dialog's disabled buttons.
    if (!recoveryAssistant || recoveryPending) {
      return;
    }
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
        // it and every gateway call would 401, so drop it and the reconnect mints
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
    if (!recoveryAssistant || recoveryPending) {
      return;
    }
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

  const closeRemoveDialog = () => {
    if (removePending) {
      return;
    }
    setRemoveTarget(null);
    setRemoveError(null);
  };

  const handleRemoveConfirm = async () => {
    if (!removeTarget || removePending) {
      return;
    }
    setRemovePending(true);
    setRemoveError(null);
    try {
      const result = await removePlatformAssistantFromLockfile(removeTarget.id);
      if (result.ok) {
        removedThisVisitRef.current = true;
        setRemoveTarget(null);
      } else {
        setRemoveError(result.error ?? "Failed to remove. Please try again.");
      }
    } catch (err) {
      console.error("selectAssistant.removeFromDevice failed", err);
      setRemoveError("Failed to remove. Please try again.");
    }
    setRemovePending(false);
  };

  // Auto-skip when there's exactly one assistant and it's accessible.
  // Don't skip when the user just logged in or navigated here deliberately
  // (e.g. from settings or the Developer menu): let them see the chooser.
  // Reactive to assistants so it fires when the store populates after mount.
  useEffect(() => {
    if (fromLogin || noAutoSkip || removedThisVisitRef.current) {
      return;
    }
    if (connecting || autoSkipping) {
      return;
    }
    if (assistants.length === 0) {
      return;
    }
    if (assistants.length === 1 && accessibleAssistants.length === 1) {
      setAutoSkipping(true);
      void handleConnect(accessibleAssistants[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistants.length, accessibleAssistants.length]);

  const onContinue = () => {
    const assistant = assistants.find((a) => a.id === selected);
    if (assistant) {
      void handleConnect(assistant);
    }
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
      <SessionCornerAction
        loginLoading={loginLoading}
        onLogin={() => void login()}
        onCancelLogin={cancelLogin}
      />
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "min-h-screen px-6 pb-40 pt-6"} text-[var(--content-default)]`}
      >
        {/* The main block floats in the space above the creature footer;
            electron keeps its compact top-aligned flow. */}
        <div
          className={`flex w-full flex-col items-center ${electron ? "" : "flex-1 justify-center"}`}
        >
        <h1
          className={`text-center ${
            electron
              ? "text-title-large"
              : "text-3xl font-semibold tracking-tight"
          }`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          Choose an Assistant
        </h1>

        {displayError && (
          <p className="mt-4 text-body-small-default text-[var(--system-negative-strong)]">
            {displayError}
          </p>
        )}

        <div
          role="radiogroup"
          aria-label="Assistants"
          onKeyDown={handleRadioCardArrowNav}
          className={`flex w-full flex-col ${electron ? "mt-8 gap-2" : "mt-10 gap-3"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          {assistants.map((assistant) => {
            const accessible = isAccessible(assistant);
            return (
              <AssistantCard
                key={assistant.id}
                assistant={assistant}
                selected={selected === assistant.id}
                locked={!accessible}
                tabStop={
                  selected == null
                    ? accessibleAssistants[0]?.id === assistant.id
                    : selected === assistant.id
                }
                onSelect={() => {
                  if (accessible) {
                    setSelected(assistant.id);
                  }
                }}
                loginLabel={loginLoading ? "Cancel" : "Log in to use"}
                loginDisabled={connecting}
                onLogin={
                  !accessible && assistant.isPlatformHosted
                    ? loginLoading
                      ? cancelLogin
                      : () => void login()
                    : undefined
                }
                onRemove={
                  assistant.isPlatformHosted && canRemoveLockedAssistants
                    ? () => setRemoveTarget(assistant)
                    : undefined
                }
              />
            );
          })}
          <button
            type="button"
            onClick={() =>
              void navigate(
                `${routes.onboarding.hosting}?from=select-assistant`,
              )
            }
            disabled={connecting || loginLoading}
            className={[
              "group flex w-full items-center justify-center gap-2 border border-dashed border-[var(--border-element)]/50 text-[var(--content-tertiary)]",
              electron ? "rounded-lg px-3 py-2.5" : "rounded-xl px-5 py-3",
              "cursor-pointer transition-all duration-200 ease-out",
              "hover:border-[var(--border-element)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
              "disabled:cursor-not-allowed disabled:opacity-50",
            ].join(" ")}
          >
            <Plus className="h-4 w-4" />
            <span
              className={
                electron ? "text-body-small-default" : "text-body-medium-default"
              }
            >
              Create a new assistant
            </span>
          </button>
        </div>

        {accessibleAssistants.length > 0 && (
          <div
            className="mt-8 w-full"
            style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
          >
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
          </div>
        )}
        <div
          className={accessibleAssistants.length > 0 ? "mt-3" : "mt-8"}
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Button
            variant="ghost"
            size="compact"
            className="text-[var(--content-tertiary)]"
            leftIcon={<ArrowLeft />}
            onClick={onBack}
            disabled={connecting || loginLoading}
          >
            Back
          </Button>
        </div>
        </div>
      </div>
      <ConnectRecoveryDialog
        open={recoveryAssistant != null}
        assistantName={
          recoveryAssistant ? assistantLabel(recoveryAssistant) : ""
        }
        isPending={recoveryPending}
        errorMessage={recoveryError ?? undefined}
        onCancel={clearRecoveryState}
        onRepair={() => void handleRecoveryRepair()}
        onRetire={() => void handleRecoveryRetire()}
      />
      <ConfirmDialog
        open={removeTarget != null}
        title="Remove from this device?"
        message={
          <>
            This won&rsquo;t delete{" "}
            {removeTarget ? assistantLabel(removeTarget) : "the assistant"}.
            It only removes it from this device. Logging in will make it
            available again.
            {removeError && (
              <span className="mt-2 block text-[var(--system-negative-strong)]">
                {removeError}
              </span>
            )}
          </>
        }
        confirmLabel="Remove"
        destructive
        isPending={removePending}
        onConfirm={() => void handleRemoveConfirm()}
        onCancel={closeRemoveDialog}
      />
    </OnboardingLayout>
  );
}

function AssistantCard({
  assistant,
  selected,
  locked,
  tabStop,
  onSelect,
  loginLabel,
  loginDisabled,
  onLogin,
  onRemove,
}: {
  assistant: ResolvedAssistant;
  selected: boolean;
  /** Not selectable in this session (platform-hosted without a login). */
  locked: boolean;
  /** The radiogroup's single roving tab stop lands on this card. */
  tabStop: boolean;
  onSelect: () => void;
  loginLabel: string;
  loginDisabled: boolean;
  /** Present only on locked platform cards: log in to unlock this assistant. */
  onLogin?: () => void;
  /** Present when the entry can be forgotten on this device: opens the confirm. */
  onRemove?: () => void;
}) {
  const subtitle = assistantSubtitle(assistant);
  // Electron compacts the card to the Swift client's onboarding-card metrics
  // (12px padding, 12px radius, 12px icon→text gap, 11px secondary text) so
  // the picker reads at the same density as the native windows.
  const electron = isElectron();

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
        electron ? "gap-3 rounded-lg p-3" : "gap-4 rounded-2xl px-5 py-4",
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
          electron ? "h-8 w-8 rounded-lg" : "h-10 w-10 rounded-xl",
          selected && !locked
            ? "bg-[var(--primary-base)] text-[var(--surface-base)]"
            : "bg-[var(--surface-active)]/40 text-[var(--content-secondary)]",
        ].join(" ")}
      >
        {assistant.isLocal ? (
          <Laptop className="h-5 w-5" />
        ) : (
          <Cloud className="h-5 w-5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <span className="block text-body-medium-default text-[var(--content-default)]">
          {assistantLabel(assistant)}
        </span>
        <span
          className={`mt-0.5 block text-[var(--content-tertiary)] ${electron ? "text-label-medium-default" : "text-body-small-default"}`}
        >
          {subtitle}
        </span>
      </div>

      {locked ? (
        <div className="flex shrink-0 items-center gap-2">
          {onLogin && (
            <Button
              variant="primary"
              size="regular"
              onClick={onLogin}
              disabled={loginDisabled}
            >
              {loginLabel}
            </Button>
          )}
          {onRemove && (
            <Menu.Root>
              <Menu.Trigger asChild>
                <Button
                  variant="ghost"
                  size="regular"
                  className="text-[var(--content-tertiary)]"
                  iconOnly={<EllipsisVertical />}
                  aria-label={`Actions for ${assistantLabel(assistant)}`}
                />
              </Menu.Trigger>
              <Menu.Content align="end" sideOffset={4}>
                <Menu.Item
                  onSelect={onRemove}
                  className="text-[var(--system-negative-strong)] data-[highlighted]:text-[var(--system-negative-strong)]"
                >
                  Remove from this device…
                </Menu.Item>
              </Menu.Content>
            </Menu.Root>
          )}
        </div>
      ) : (
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
