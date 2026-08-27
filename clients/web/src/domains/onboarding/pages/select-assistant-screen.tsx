import {
  Check,
  Cloud,
  EllipsisVertical,
  Globe,
  Laptop,
  Link2,
  Plus,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";

import { refreshPlatformAssistantsIfStale } from "@/assistant/platform-assistants-sync";
import { resolveSelectedAssistantId } from "@/assistant/selection";
import { retireAssistant } from "@/assistant/retire-service";
import { isCurrentOrigin, switchToOrigin } from "@/assistant/switch-origin";
import {
  removePairedAssistant,
  switchToResolvedAssistant,
} from "@/assistant/switch-service";
import { ChooserAvatarChip } from "@/components/avatar/chooser-avatar-chip";
import { RemoveFromDeviceDialog } from "@/components/remove-from-device-dialog";
import {
  clearGatewayToken,
  isRepairableGatewayTokenError,
} from "@/lib/auth/gateway-session";
import {
  isCliWakeableAssistant,
  isLocalClient,
  removePlatformAssistantFromLockfile,
  UnresolvedLocalGatewayError,
} from "@/lib/local-mode";
import { AddRemoteOriginDialog } from "@/domains/onboarding/components/add-remote-origin-dialog";
import { ConnectAssistantDialog } from "@/domains/onboarding/components/connect-assistant-dialog";
import { ConnectRecoveryDialog } from "@/domains/onboarding/components/connect-recovery-dialog";
import { OnboardingLayout } from "@/components/onboarding-layout";
import { handleRadioCardArrowNav } from "@/domains/onboarding/components/radio-card-nav";
import { formatRelativeDate } from "@/utils/format-date";
import {
  forgetAssistantAvatar,
  useChooserRowAvatar,
} from "@/hooks/use-chooser-row-avatar";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { isElectron } from "@/runtime/is-electron";
import {
  isLocalModeHostAvailable,
  requiresGuardianReprovision,
  wakeLocalAssistantHost,
} from "@/runtime/local-mode-host";
import { useIsNativeMobile } from "@/runtime/platform-detection";
import {
  installNativeRememberedOrigins,
  nativeSwitchToOrigin,
  nativeVellumCloudOrigin,
} from "@/runtime/self-hosted-servers";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useConnectDialogStore } from "@/stores/connect-dialog-store";
import { useOrganizationStore } from "@/stores/organization-store";
import {
  normalizeOriginUrl,
  useRememberedOriginsStore,
  type RememberedOrigin,
} from "@/stores/remembered-origins-store";
import {
  isConnectableFromThisDevice,
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";
import { pairedHostLabel } from "@vellumai/local-mode/contract";
import { Button } from "@vellumai/design-library/components/button";
import { Menu } from "@vellumai/design-library/components/menu";
import { useTranslation } from "@/i18n";
import type { TFunction } from "i18next";

function assistantLabel(a: ResolvedAssistant): string {
  if (a.name) {
    return a.name;
  }
  if (a.isPaired) {
    return "Paired Assistant";
  }
  if (a.isLocal && a.cloud === "local") {
    // Lockfile-sourced local ids are friendly generated instance names;
    // API-sourced hub registrations carry platform UUIDs instead.
    return a.id;
  }
  if (a.isLocal) {
    return "Local Assistant";
  }
  return "Cloud Assistant";
}

/** A hub-listed self-hosted entry lives on another machine; name its host. */
function selfHostedHostLabel(
  ingressUrl: string | null | undefined,
  t: TFunction<"onboarding">,
): string {
  if (ingressUrl) {
    try {
      return t("selectAssistantScreen.selfHostedWithHost", {
        host: new URL(ingressUrl).hostname,
      });
    } catch {
      // Unparseable ingress url: plain label.
    }
  }
  return t("selectAssistantScreen.selfHosted");
}

function assistantSubtitle(
  a: ResolvedAssistant,
  t: TFunction<"onboarding">,
): string {
  const hosting = a.isPaired
    ? pairedHostLabel(a.runtimeUrl)
    : a.isLocal
      ? isLocalClient()
        ? "On this computer"
        : selfHostedHostLabel(a.ingressUrl, t)
      : "Cloud-hosted";
  if (!a.hatchedAt) {
    return hosting;
  }
  return `${hosting} · Created ${formatRelativeDate(a.hatchedAt)}`;
}

/**
 * What an origin card renders from. The baked Vellum Cloud origin a native
 * shell reports has no `addedAt` of its own, so the card asks only for the
 * identity and the label.
 */
type OriginCardEntry = Pick<RememberedOrigin, "name" | "url">;

function originHostname(origin: OriginCardEntry): string {
  return new URL(origin.url).hostname;
}

function originLabel(origin: OriginCardEntry): string {
  return origin.name ?? originHostname(origin);
}

/**
 * Selection key for a remembered-origin card in the shared radio group.
 * Assistant ids never carry a scheme, so the prefixed url cannot collide.
 */
function originSelectionKey(origin: OriginCardEntry): string {
  return `origin:${origin.url}`;
}

/** Selection key for the native shell's baked Vellum Cloud card. */
const CLOUD_SELECTION_KEY = "origin:vellum-cloud";

/**
 * The consumed `register`/`name` handoff params dropped from `params`,
 * preserving everything else, so a reload does not re-run the registration.
 */
function withoutRegisterParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("register");
  next.delete("name");
  return next;
}

export function SelectAssistantScreen() {
  const { t } = useTranslation("onboarding");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const fromLogin = searchParams.get("fromLogin") === "1";
  const noAutoSkip = searchParams.get("noAutoSkip") === "1";
  const electron = isElectron();
  const localClient = isLocalClient();
  const hasPlatformSession = useHasPlatformSession();
  const assistants = useResolvedAssistantsStore.use.assistants();
  const currentOrganizationId =
    useOrganizationStore.use.currentOrganizationId();
  const originEntries = useRememberedOriginsStore.use.origins();
  const originsHydrated = useRememberedOriginsStore.use.hydrated();
  const nativeMobile = useIsNativeMobile();
  const {
    loading: loginLoading,
    error: loginError,
    login,
    cancel: cancelLogin,
  } = useOnboardingLogin();

  // The native shell's baked Vellum Cloud origin, present only while the shell
  // is pointed somewhere else and only on a build carrying the plugin.
  const [cloudOriginUrl, setCloudOriginUrl] = useState<string | null>(null);
  const cloudOrigin: OriginCardEntry | null =
    cloudOriginUrl !== null
      ? { url: cloudOriginUrl, name: "Vellum Cloud" }
      : null;
  // Stable dep for the selection effect: `cloudOrigin` is a fresh object each
  // render.
  const cloudOriginOffered = cloudOrigin !== null;

  // A local entry is session-free only where a local transport exists; on
  // the hub it connects through the platform path, so like a managed entry
  // it needs the platform session.
  const isAccessible = (a: ResolvedAssistant): boolean =>
    a.isPaired || (a.isLocal && localClient) || hasPlatformSession;

  // `setFromApi` already drops unreachable local registrations, but a
  // lifecycle upsert of a stale persisted selection can still land one in the
  // store; keep dead entries off the chooser regardless of how they arrived.
  const visibleAssistants = assistants.filter(isConnectableFromThisDevice);
  const accessibleAssistants = visibleAssistants.filter(isAccessible);
  // Origin cards are always selectable, so any kind of entry gives Continue
  // something to act on.
  const hasSelectableEntries =
    accessibleAssistants.length > 0 ||
    originEntries.length > 0 ||
    cloudOrigin !== null;

  // Unpairing and completing a pairing both rewrite the lockfile through the
  // local-mode host, and a pairing is device-local regardless of platform
  // session: one gate covers the paired-removal and connect affordances
  // (never shown in remote-gateway mode or hostless browsers).
  const localModeHostAvailable = isLocalModeHostAvailable();
  // A locked platform entry can be forgotten on this device (dropped from the
  // lockfile) only where that same host is present and the user is logged out.
  const canRemoveLockedAssistants =
    !hasPlatformSession && localModeHostAvailable;

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
  // The URL-only "Add a remote assistant" dialog (hub surfaces without a
  // local-mode host).
  const [addOriginOpen, setAddOriginOpen] = useState(false);
  // Target of the remembered-origin removal confirmation dialog.
  const [removeOriginTarget, setRemoveOriginTarget] =
    useState<RememberedOrigin | null>(null);
  const [removeOriginPending, setRemoveOriginPending] = useState(false);
  const [removeOriginError, setRemoveOriginError] = useState<string | null>(
    null,
  );
  // The "Connect a remote assistant" dialog. Store-driven rather than local
  // state so a `<scheme>://connect` deep link parked by the global consumer
  // opens it on mount, carrying an address prefill or guidance copy.
  const connectDialogOpen = useConnectDialogStore.use.open();
  const connectInitialAddress = useConnectDialogStore.use.initialAddress();
  const connectGuidanceKind = useConnectDialogStore.use.guidanceKind();
  // Electron buffers deep links that arrive before the renderer exists and
  // drains them shortly after mount; the auto-skip below defers until that
  // drain settles so a cold-start connect link opens the dialog first.
  const deepLinkDrainSettled = useConnectDialogStore.use.deepLinkDrainSettled();
  // After a manual removal the user is mid-management on this screen: a
  // sudden auto-connect to the sole remaining assistant would be jarring, so
  // the auto-skip stands down for the rest of the visit.
  const removedThisVisitRef = useRef(false);

  // Post-hatch ingress provisioning can land after the last list fetch;
  // refresh on mount so the new assistant shows up. Session and mode guards
  // live in the sync module, so this is a no-op off a logged-in hub.
  useEffect(() => {
    void refreshPlatformAssistantsIfStale();
  }, []);

  useEffect(() => {
    // Native mobile keeps its origins in the shell rather than in web
    // storage, so the provider swap happens before the first load.
    installNativeRememberedOrigins();
    void useRememberedOriginsStore.getState().hydrate();
  }, []);

  // The way back to Vellum Cloud, offered only by a shell that is currently
  // serving a self-hosted origin.
  useEffect(() => {
    if (!nativeMobile) {
      return;
    }
    let cancelled = false;
    void nativeVellumCloudOrigin().then((url) => {
      if (!cancelled) {
        setCloudOriginUrl(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [nativeMobile]);

  // `?register=<url>&name=<label>` handoff: another origin's Switch
  // Assistant action self-registers here so the hub lists it. Records the
  // entry (renaming an existing one) and strips the params through the
  // router, so router state and the address bar stay in step; it never
  // navigates away, so the user sees the updated list. Consumed at most
  // once. Only a name and an https URL ride the params; anything failing
  // `normalizeOriginUrl` is dropped silently (and stripped, since retrying
  // cannot fix it). A failed add keeps the params and releases the ref so a
  // reload can retry the registration.
  const registerHandledRef = useRef(false);
  useEffect(() => {
    if (registerHandledRef.current) {
      return;
    }
    registerHandledRef.current = true;
    const register = searchParams.get("register");
    if (register === null) {
      return;
    }
    const clearParams = () =>
      setSearchParams(withoutRegisterParams, { replace: true });
    const normalized = normalizeOriginUrl(register);
    if (normalized === null) {
      clearParams();
      return;
    }
    void useRememberedOriginsStore
      .getState()
      .addOrigin({
        url: normalized,
        name: searchParams.get("name") ?? undefined,
      })
      .then((result) => {
        if (result.ok) {
          clearParams();
        } else {
          registerHandledRef.current = false;
        }
      })
      .catch(() => {
        registerHandledRef.current = false;
      });
  }, [searchParams, setSearchParams]);

  // Default selection: the app's known selected assistant when accessible,
  // else the first accessible assistant, else the first origin card. Also
  // reconciles an existing selection that stops being accessible (an
  // in-place logout locks the platform cards), so Continue can never target
  // a locked assistant. A selected remembered origin needs no session, so it
  // stands.
  useEffect(() => {
    if (selected === CLOUD_SELECTION_KEY && cloudOriginOffered) {
      return;
    }
    if (
      selected != null &&
      originEntries.some((o) => originSelectionKey(o) === selected)
    ) {
      return;
    }
    if (accessibleAssistants.length === 0) {
      // Without this an origins-only chooser has no default and Continue
      // renders permanently disabled.
      const firstOrigin = originEntries[0];
      const fallback = firstOrigin
        ? originSelectionKey(firstOrigin)
        : cloudOriginOffered
          ? CLOUD_SELECTION_KEY
          : null;
      if (selected !== fallback) {
        setSelected(fallback);
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
  }, [
    selected,
    accessibleAssistants,
    currentOrganizationId,
    originEntries,
    cloudOriginOffered,
  ]);

  const handleConnect = async (assistant: ResolvedAssistant) => {
    setConnecting(true);
    setError(null);
    try {
      await switchToResolvedAssistant(assistant);
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
      } else if (assistant.isPaired && requiresGuardianReprovision(err)) {
        // The host's own guardian-token message says to re-run hatch/wake,
        // which cannot fix a remote pairing; surface re-pair guidance instead.
        setError(
          "This pairing has expired. Run vellum pair on the assistant's machine and import it again with vellum connect import.",
        );
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
      const outcome = await retireAssistant(queryClient, recoveryAssistant.id);
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
    if (removeTarget.isPaired) {
      // The shared service owns the paired sequence (lockfile removal plus
      // lifecycle active-id cleanup); its chooser-route outcome is ignored
      // because this screen is already the chooser.
      const outcome = await removePairedAssistant(queryClient, removeTarget.id);
      if (outcome.ok) {
        removedThisVisitRef.current = true;
        setRemoveTarget(null);
      } else {
        setRemoveError(outcome.error);
      }
      setRemovePending(false);
      return;
    }
    try {
      const result = await removePlatformAssistantFromLockfile(removeTarget.id);
      if (result.ok) {
        // The lockfile subscription reconciles the list and the selection,
        // but not the lifecycle's active id: without this, navigating back
        // to /assistant could admit the removed assistant with no
        // connection behind it.
        const resolvedStore = useResolvedAssistantsStore.getState();
        if (resolvedStore.activeAssistantId === removeTarget.id) {
          resolvedStore.setActiveAssistantId(null);
        }
        // Same cleanup as the paired path: a later login re-adds this id,
        // and a stale last-seen entry or query would render the old avatar.
        forgetAssistantAvatar(queryClient, removeTarget.id);
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

  const closeRemoveOriginDialog = () => {
    if (removeOriginPending) {
      return;
    }
    setRemoveOriginTarget(null);
    setRemoveOriginError(null);
  };

  const handleRemoveOriginConfirm = async () => {
    if (!removeOriginTarget || removeOriginPending) {
      return;
    }
    setRemoveOriginPending(true);
    setRemoveOriginError(null);
    await useRememberedOriginsStore
      .getState()
      .removeOrigin(removeOriginTarget.url);
    // removeOrigin resolves silently on a persistence failure, so the entry
    // still being listed is the failure signal.
    const stillListed = useRememberedOriginsStore
      .getState()
      .origins.some((o) => o.url === removeOriginTarget.url);
    if (stillListed) {
      setRemoveOriginError("Failed to remove. Please try again.");
    } else {
      removedThisVisitRef.current = true;
      setRemoveOriginTarget(null);
    }
    setRemoveOriginPending(false);
  };

  const handleImported = (assistantId: string) => {
    useConnectDialogStore.getState().closeConnectDialog();
    // The import refreshes the lockfile before resolving, so the store already
    // lists the new entry; the fallback keeps the connect total if it lags.
    const imported = useResolvedAssistantsStore
      .getState()
      .assistants.find((a) => a.id === assistantId);
    void handleConnect(
      imported ?? {
        id: assistantId,
        isLocal: false,
        isPlatformHosted: false,
        isPaired: true,
      },
    );
  };

  // `deviceCode` is one-time credential material and is never persisted: the
  // store holds the base alone, and the code lives just long enough to ride
  // the navigation into the origin's own pair page.
  const handleOriginAdded = (
    origin: RememberedOrigin,
    deviceCode: string | null,
  ) => {
    setAddOriginOpen(false);
    // Landing on the origin runs its own pair flow when no session exists.
    void switchToOrigin(origin, deviceCode ?? undefined);
  };

  // Auto-skip when there's exactly one assistant and it's accessible.
  // Don't skip when the user just logged in or navigated here deliberately
  // (e.g. from settings or the Developer menu): let them see the chooser.
  // Reactive to assistants so it fires when the store populates after mount.
  useEffect(() => {
    if (fromLogin || noAutoSkip || removedThisVisitRef.current) {
      return;
    }
    // The platform hub always shows the chooser rather than auto-connecting.
    if (!localClient) {
      return;
    }
    // Remembered origins are alternatives a sole assistant does not account
    // for, so the chooser stays up whenever any exist. The entries land after
    // mount, so hold the skip until they have.
    if (!originsHydrated) {
      return;
    }
    if (originEntries.length > 0) {
      return;
    }
    // On a cold Electron start the buffered deep links publish after mount;
    // hold the skip until the drain settles so a parked connect link wins
    // (it opens the dialog, which stands the auto-skip down below).
    if (electron && !deepLinkDrainSettled) {
      return;
    }
    if (connecting || autoSkipping || connectDialogOpen) {
      return;
    }
    if (visibleAssistants.length === 0) {
      return;
    }
    if (visibleAssistants.length === 1 && accessibleAssistants.length === 1) {
      setAutoSkipping(true);
      void handleConnect(accessibleAssistants[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visibleAssistants.length,
    accessibleAssistants.length,
    deepLinkDrainSettled,
    localClient,
    originEntries.length,
    originsHydrated,
  ]);

  const onContinue = () => {
    if (selected === CLOUD_SELECTION_KEY) {
      // A rejected bridge switch leaves the shell where it is, so fall back
      // to a plain navigation. The baked url is the hub's assistant root
      // already (the shell's `server.url`), unlike a remembered origin's
      // bare base.
      void nativeSwitchToOrigin(null).then((switched) => {
        if (!switched && cloudOriginUrl !== null) {
          window.location.assign(cloudOriginUrl);
        }
      });
      return;
    }
    const origin = originEntries.find(
      (o) => originSelectionKey(o) === selected,
    );
    if (origin) {
      if (isCurrentOrigin(origin)) {
        void navigate(routes.assistant, { replace: true });
      } else {
        void switchToOrigin(origin);
      }
      return;
    }
    const assistant = visibleAssistants.find((a) => a.id === selected);
    if (assistant) {
      void handleConnect(assistant);
    }
  };

  const onBack = () => {
    // welcome is local-only; the platform hub's way back is the app itself.
    void navigate(localClient ? routes.welcome : routes.assistant);
  };

  const displayError = loginError ?? error;

  // Loading state during auto-skip. A pending recovery falls through to the
  // chooser so the dialog can render.
  if (autoSkipping && !displayError && !recoveryAssistant) {
    return <ConnectingHold />;
  }

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
            className="text-center text-5xl font-normal tracking-tight md:text-4xl lg:text-5xl"
            style={{
              fontFamily: "var(--font-serif)",
              animation: "fadeInUp 0.5s ease-out 0.1s both",
            }}
          >
            {t("selectAssistantScreen.title")}
          </h1>

          {displayError && (
            <p className="mt-4 text-body-small-default text-[var(--system-negative-strong)]">
              {displayError}
            </p>
          )}

          <div
            role="radiogroup"
            aria-label={t("selectAssistantScreen.listAriaLabel")}
            onKeyDown={handleRadioCardArrowNav}
            className={`flex w-full flex-col ${electron ? "mt-8 gap-2" : "mt-10 gap-3"}`}
            style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
          >
            {visibleAssistants.map((assistant) => {
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
                  loginLabel={
                    loginLoading ? t("actions.cancel") : t("actions.loginToUse")
                  }
                  loginDisabled={connecting}
                  onLogin={
                    // Locked platform-hosted and hub-local cards both unlock
                    // with a platform login (both connect via the platform).
                    !accessible &&
                    (assistant.isPlatformHosted || assistant.isLocal)
                      ? loginLoading
                        ? cancelLogin
                        : () => void login()
                      : undefined
                  }
                  onRemove={
                    (assistant.isPlatformHosted && canRemoveLockedAssistants) ||
                    (assistant.isPaired && localModeHostAvailable)
                      ? () => setRemoveTarget(assistant)
                      : undefined
                  }
                />
              );
            })}
            {originEntries.map((origin, index) => {
              const key = originSelectionKey(origin);
              // Forgetting the origin a native shell is serving clears its
              // active slot and relocates the app, which the removal copy
              // promises it will not do, so the current card has no menu.
              const current = isCurrentOrigin(origin);
              return (
                <RemoteOriginCard
                  key={origin.url}
                  origin={origin}
                  selected={selected === key}
                  current={current}
                  tabStop={
                    selected == null
                      ? accessibleAssistants.length === 0 && index === 0
                      : selected === key
                  }
                  onSelect={() => setSelected(key)}
                  onRemove={
                    // Forgetting the current entry on a native shell relocates
                    // the app to the baked origin, which the dialog copy does
                    // not promise. Elsewhere the list is local and inert.
                    current && nativeMobile
                      ? undefined
                      : () => setRemoveOriginTarget(origin)
                  }
                />
              );
            })}
            {cloudOrigin && (
              <RemoteOriginCard
                origin={cloudOrigin}
                icon={<Cloud className="h-5 w-5" />}
                selected={selected === CLOUD_SELECTION_KEY}
                current={false}
                tabStop={
                  selected == null
                    ? accessibleAssistants.length === 0 &&
                      originEntries.length === 0
                    : selected === CLOUD_SELECTION_KEY
                }
                onSelect={() => setSelected(CLOUD_SELECTION_KEY)}
              />
            )}
            {localClient && (
              <DashedActionButton
                icon={<Plus className="h-4 w-4" />}
                label={t("selectAssistantScreen.createNew")}
                disabled={connecting || loginLoading}
                onClick={() =>
                  void navigate(
                    `${routes.onboarding.hosting}?from=select-assistant`,
                  )
                }
              />
            )}
            {localModeHostAvailable && (
              <DashedActionButton
                icon={<Link2 className="h-4 w-4" />}
                label={t("selectAssistantScreen.connectRemote")}
                disabled={connecting || loginLoading}
                onClick={() =>
                  useConnectDialogStore.getState().openConnectDialog()
                }
              />
            )}
            {/* Hostless surfaces (hub browser, remote-gateway mode, native
              mobile) add an origin by address or pairing link and navigate to
              it; clients with a local-mode host pair in place through the
              connect dialog above instead. */}
            {!localModeHostAvailable && (
              <DashedActionButton
                icon={<Globe className="h-4 w-4" />}
                label={t("selectAssistantScreen.addRemote")}
                disabled={connecting || loginLoading}
                onClick={() => setAddOriginOpen(true)}
              />
            )}
          </div>

          {hasSelectableEntries && (
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
                {connecting ? t("actions.connecting") : t("actions.continue")}
              </Button>
            </div>
          )}
          <div
            className={hasSelectableEntries ? "mt-3" : "mt-8"}
            style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
          >
            <Button
              variant="ghost"
              size="regular"
              className="text-[var(--content-tertiary)]"
              onClick={onBack}
              disabled={connecting || loginLoading}
            >
              {t("actions.back")}
            </Button>
          </div>
        </div>
      </div>
      <AddRemoteOriginDialog
        open={addOriginOpen}
        onClose={() => setAddOriginOpen(false)}
        onAdded={handleOriginAdded}
      />
      <ConnectAssistantDialog
        open={connectDialogOpen}
        initialAddress={connectInitialAddress ?? undefined}
        guidanceKind={connectGuidanceKind ?? undefined}
        onClose={() => useConnectDialogStore.getState().closeConnectDialog()}
        onImported={handleImported}
      />
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
      <RemoveFromDeviceDialog
        open={removeTarget != null}
        kind={removeTarget?.isPaired ? "paired" : "platform"}
        assistantName={
          removeTarget
            ? assistantLabel(removeTarget)
            : t("selectAssistantScreen.unnamedAssistant")
        }
        errorMessage={removeError ?? undefined}
        isPending={removePending}
        onConfirm={() => void handleRemoveConfirm()}
        onCancel={closeRemoveDialog}
      />
      <RemoveFromDeviceDialog
        open={removeOriginTarget != null}
        kind="origin"
        assistantName={
          removeOriginTarget
            ? originLabel(removeOriginTarget)
            : t("selectAssistantScreen.unnamedAssistant")
        }
        errorMessage={removeOriginError ?? undefined}
        isPending={removeOriginPending}
        onConfirm={() => void handleRemoveOriginConfirm()}
        onCancel={closeRemoveOriginDialog}
      />
    </OnboardingLayout>
  );
}

/** Full-screen "Connecting…" hold shown while a decision or connect lands. */
function ConnectingHold() {
  const { t } = useTranslation("onboarding");
  return (
    <OnboardingLayout avatarWave="beside">
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-6 text-[var(--content-default)]">
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("selectAssistantScreen.connectingToAssistant")}
        </p>
      </div>
    </OnboardingLayout>
  );
}

/** Dashed full-width secondary action below the assistant cards. */
function DashedActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const electron = isElectron();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "group flex w-full items-center justify-center gap-2 border border-dashed border-[var(--border-element)]/50 text-[var(--content-tertiary)]",
        electron ? "rounded-lg px-3 py-2.5" : "rounded-xl px-5 py-3",
        "cursor-pointer transition-all duration-200 ease-out",
        "hover:border-[var(--border-element)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
      ].join(" ")}
    >
      {icon}
      <span
        className={
          electron ? "text-body-small-default" : "text-body-medium-default"
        }
      >
        {label}
      </span>
    </button>
  );
}

/** Overflow menu opening the remove-from-this-device confirmation. */
function RemoveCardMenu({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  const { t } = useTranslation("onboarding");
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button
          variant="ghost"
          size="regular"
          className="text-[var(--content-tertiary)]"
          iconOnly={<EllipsisVertical />}
          aria-label={t("selectAssistantScreen.rowActionsAriaLabel", {
            name: label,
          })}
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          onSelect={onRemove}
          className="text-[var(--system-negative-strong)] data-[highlighted]:text-[var(--system-negative-strong)]"
        >
          {t("selectAssistantScreen.removeFromDevice")}
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

/**
 * Radio-card shell every chooser entry renders through: icon, title,
 * subtitle, the roving tab stop, and the right-hand affordance cluster. A
 * locked card (a platform assistant with no session) drops the radio
 * semantics and the selected dot, keeping only its actions.
 */
function ChooserCard({
  icon,
  title,
  subtitle,
  selected,
  locked = false,
  tabStop,
  onSelect,
  action,
  removeMenu,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  selected: boolean;
  /** Not selectable in this session (platform-hosted without a login). */
  locked?: boolean;
  /** The radiogroup's single roving tab stop lands on this card. */
  tabStop: boolean;
  onSelect: () => void;
  /** Leading right-hand affordance, e.g. a locked card's log-in button. */
  action?: ReactNode;
  /** Present when the entry can be forgotten on this device. */
  removeMenu?: ReactNode;
}) {
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
        electron
          ? "gap-3 rounded-lg px-[10px] py-3"
          : "gap-4 rounded-2xl px-[18px] py-4",
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
          "h-12 w-12 rounded-[10px]",
          selected && !locked
            ? "bg-[var(--primary-base)] text-[var(--surface-base)]"
            : "bg-[var(--surface-active)]/40 text-[var(--content-secondary)]",
        ].join(" ")}
      >
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        <span className="block text-body-medium-default text-[var(--content-default)]">
          {title}
        </span>
        <span
          className={`mt-1 block text-[var(--content-tertiary)] ${electron ? "text-label-medium-default font-normal" : "text-body-small-lighter"}`}
        >
          {subtitle}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {action}
        {removeMenu &&
          (locked ? (
            removeMenu
          ) : (
            /* The trigger sits inside the radio card: stop clicks and keys
               from bubbling so opening the menu never selects the card and
               the radio's Enter/Space handler never swallows the trigger. */
            <div
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {removeMenu}
            </div>
          ))}
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
    </div>
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
  /** Present only on locked platform-routed cards: log in to unlock. */
  onLogin?: () => void;
  /** Present when the entry can be forgotten on this device: opens the confirm. */
  onRemove?: () => void;
}) {
  const { t } = useTranslation("onboarding");
  const label = assistantLabel(assistant);
  const { traits, imageUrl, onImageError } = useChooserRowAvatar(assistant);
  const glyph = assistant.isPaired ? (
    <Link2 className="h-5 w-5" />
  ) : assistant.isLocal ? (
    <Laptop className="h-5 w-5" />
  ) : (
    <Cloud className="h-5 w-5" />
  );
  return (
    <ChooserCard
      icon={
        <ChooserAvatarChip
          traits={traits}
          imageUrl={imageUrl}
          fallback={glyph}
          decorative
          onImageError={onImageError}
        />
      }
      title={label}
      subtitle={assistantSubtitle(assistant, t)}
      selected={selected}
      locked={locked}
      tabStop={tabStop}
      onSelect={onSelect}
      action={
        locked && onLogin ? (
          <Button
            variant="primary"
            size="regular"
            onClick={onLogin}
            disabled={loginDisabled}
          >
            {loginLabel}
          </Button>
        ) : undefined
      }
      removeMenu={
        onRemove && <RemoveCardMenu label={label} onRemove={onRemove} />
      }
    />
  );
}

/**
 * Chooser card for a remote origin. An origin is only an address: it is
 * always selectable (no session is needed to navigate away), and its menu
 * removal only forgets the entry on this device. The native shell's baked
 * Vellum Cloud origin reuses the card without a menu, since there is no
 * device-local entry to forget.
 */
function RemoteOriginCard({
  origin,
  icon,
  selected,
  current,
  tabStop,
  onSelect,
  onRemove,
}: {
  origin: OriginCardEntry;
  /** Defaults to the remote-origin globe. */
  icon?: ReactNode;
  selected: boolean;
  /** Whether this origin is the deployment serving the running app. */
  current: boolean;
  /** The radiogroup's single roving tab stop lands on this card. */
  tabStop: boolean;
  onSelect: () => void;
  /** Opens the remove-from-this-device confirmation, when there is one. */
  onRemove?: () => void;
}) {
  const { t } = useTranslation("onboarding");
  const label = originLabel(origin);
  const subtitleKey = current
    ? "selectAssistantScreen.currentWithHost"
    : "selectAssistantScreen.remoteWithHost";
  return (
    <ChooserCard
      icon={icon ?? <Globe className="h-5 w-5" />}
      title={label}
      subtitle={t(subtitleKey, { host: originHostname(origin) })}
      selected={selected}
      tabStop={tabStop}
      onSelect={onSelect}
      removeMenu={
        onRemove && <RemoveCardMenu label={label} onRemove={onRemove} />
      }
    />
  );
}
