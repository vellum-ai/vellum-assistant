/**
 * Polling hook behind the provisioning screen of the pro onboarding wizard.
 *
 * Composes the subscription poll (is the checkout webhook done?), the
 * onboarding state (what machine/storage did the package buy?), and the
 * assistant + operational-status polls (has the server-driven resize landed?)
 * into a single `ProvisioningSnapshot` derived by the pure state machine in
 * `provisioning-machine.ts`.
 *
 * While WAITING/RESIZING the assistant pod is restarting, so errors from the
 * assistant endpoints are expected — the hook keeps last-known data and never
 * surfaces them. Platform-side fetches are different: a CONFIRMING-phase
 * subscription error maps to `confirmError`, and a post-confirm onboarding
 * fetch failure with no cached data maps to `targetsError`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  assistantsActiveRetrieveOptions,
  assistantsOperationalStatusDetailReadOptions,
  assistantsRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OperationalStatus } from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { allowedMachineSizesForTier } from "@/lib/billing/machine-sizes";
import { useOrganizationStore } from "@/stores/organization-store";

import {
  deriveProvisioningState,
  type ProvisioningDimensions,
  type ProvisioningServerVerdict,
  type ProvisioningStateKind,
} from "./provisioning-machine";
import {
  PRO_POLL_INTERVAL_MS,
  PRO_POLL_TIMEOUT_MS,
  PROVISION_ESCAPE_MS,
} from "./utils";

const ACTUALS_POLL_INTERVAL_MS = 2000;
/** Re-derive elapsed-time transitions (grace/stall) between poll responses. */
const CLOCK_TICK_MS = 1000;

/**
 * STALLED is deliberately NOT terminal: the server-side resize may still be
 * running, so polling and the clock stay alive and a late-completing resize
 * self-recovers to DONE.
 */
const TERMINAL_STATES: readonly ProvisioningStateKind[] = [
  "DONE",
  "NOT_APPLICABLE",
  "CONFIRM_TIMEOUT",
];

function isResizeOperationInFlight(
  status: OperationalStatus | null | undefined,
): boolean {
  if (!status) return false;
  if (
    status.state === "resizing_machine" ||
    status.state === "resizing_storage"
  ) {
    return true;
  }
  const operation = status.active_operation?.operation;
  return typeof operation === "string" && operation.startsWith("resize");
}

export interface UseProProvisioningOptions {
  open: boolean;
  serverVerdict?: ProvisioningServerVerdict | null;
}

export interface ProProvisioningResult {
  state: ProvisioningStateKind;
  softWaiting: boolean;
  targets: ProvisioningDimensions | null;
  /** First actuals observed, frozen — the "from" side of before/after cards. */
  actualsSnapshot: ProvisioningDimensions | null;
  /**
   * The assistant provisioning targets: the onboarding payload's primary
   * assistant when named, else the active assistant. Drives the actuals and
   * operational-status polls and the stalled manual resize.
   */
  assistantId: string | null;
  /** `domain_setup_available` from the onboarding state, once loaded. */
  domainSetupAvailable: boolean | undefined;
  /**
   * The post-confirm onboarding fetch has settled — neither the cold load nor
   * the refetch from the on-open invalidation is in flight, so
   * `domainSetupAvailable` is safe to route on.
   */
  onboardingSettled: boolean;
  /** The CONFIRMING-phase subscription fetch failed. */
  confirmError: boolean;
  /** The post-confirm onboarding fetch failed with no cached data. */
  targetsError: boolean;
  /**
   * The watch has run long enough (without resolving) that the "continue in
   * the background" escape hatch may be offered. Re-bases with the stall clock
   * after a manual-apply resume.
   */
  escapeEligible: boolean;
  /** Reset the confirm timeout and re-poll the subscription. */
  retryConfirm: () => void;
  /**
   * Resume observation after a manual STALLED-state resize succeeds: latches
   * the operation as seen (back to RESIZING) and re-bases the stall clock so
   * polling and the stall timeout start over.
   */
  resumeAfterManualApply: () => void;
}

export function useProProvisioning({
  open,
  serverVerdict = null,
}: UseProProvisioningOptions): ProProvisioningResult {
  const queryClient = useQueryClient();
  // Every query here is org-scoped (needs the Vellum-Organization-Id header).
  // On the cold return from Stripe the org store may not be hydrated yet, so
  // hold the fetches until it is. The confirm timeout deliberately runs
  // regardless: if org readiness never arrives, the user still lands on the
  // payment-safe retry screen instead of an indefinite spinner.
  const orgReady = useIsOrgReady();
  const [confirmExpired, setConfirmExpired] = useState(false);
  const [confirmGeneration, setConfirmGeneration] = useState(0);
  // Wall-clock fence for confirm latching: only subscription data fetched
  // after this instant may confirm pro.
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [proConfirmedAt, setProConfirmedAt] = useState<number | null>(null);
  // Stall-clock re-base set by resumeAfterManualApply; proConfirmedAt otherwise.
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [sawOperation, setSawOperation] = useState(false);
  const [actualsSnapshot, setActualsSnapshot] =
    useState<ProvisioningDimensions | null>(null);
  // The assistant the frozen snapshot describes, so it can be re-captured when
  // the provisioning target changes rather than mismatched against new actuals.
  const [snapshotAssistantId, setSnapshotAssistantId] = useState<string | null>(
    null,
  );
  // Wall-clock time as React state so elapsed-time transitions (grace/stall)
  // re-derive between poll responses without impure Date.now() calls in render.
  const [now, setNow] = useState(() => Date.now());
  // Whether the actuals polls should keep refetching. Synced from the derived
  // state after each render (it isn't known yet when the queries are
  // declared); the one-render lag is invisible at these poll intervals.
  const [tracking, setTracking] = useState(true);

  useEffect(() => {
    if (open) return;
    setConfirmExpired(false);
    setConfirmGeneration(0);
    setOpenedAt(null);
    setProConfirmedAt(null);
    setResumedAt(null);
    setSawOperation(false);
    setActualsSnapshot(null);
    setSnapshotAssistantId(null);
    setTracking(true);
  }, [open]);

  // Refetch pre-checkout caches on open. Invalidation keeps serving cached
  // data while the refetch is in flight, so `openedAt` fences confirm
  // latching to data that actually landed after this open.
  useEffect(() => {
    if (!open) return;
    setOpenedAt(Date.now());
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
    });
  }, [open, queryClient]);

  const proConfirmed = proConfirmedAt != null;

  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    refetchInterval: (query) => {
      const planId = query.state.data?.plan_id;
      if (planId === "pro" || confirmExpired) return false;
      return PRO_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    enabled: open && orgReady && !proConfirmed,
  });

  // Reopening the wizard can serve a cached pre-downgrade "pro" while the
  // on-open refetch is still in flight; only post-open data may confirm.
  const subscriptionFresh =
    openedAt != null && subscriptionQuery.dataUpdatedAt >= openedAt;
  const observedPlanId =
    (subscriptionFresh ? subscriptionQuery.data?.plan_id : null) ?? null;

  useEffect(() => {
    if (!open || proConfirmed || observedPlanId !== "pro") return;
    const confirmedAt = Date.now();
    setProConfirmedAt(confirmedAt);
    setNow(confirmedAt);
  }, [open, proConfirmed, observedPlanId]);

  useEffect(() => {
    if (!open || proConfirmed) {
      return;
    }
    const t = setTimeout(() => setConfirmExpired(true), PRO_POLL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [open, proConfirmed, confirmGeneration]);

  const retryConfirm = useCallback(() => {
    setConfirmExpired(false);
    setConfirmGeneration((g) => g + 1);
    // A failed org-list fetch leaves every org-gated query here disabled;
    // refetching it lets the retry heal that alongside the subscription poll.
    void useOrganizationStore.getState().fetchOrganizations();
    void queryClient.invalidateQueries({
      queryKey: organizationsBillingSubscriptionRetrieveQueryKey(),
    });
  }, [queryClient]);

  const resumeAfterManualApply = useCallback(() => {
    const t = Date.now();
    setSawOperation(true);
    setResumedAt(t);
    setNow(t);
  }, []);

  const onboardingQuery = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: open && orgReady && proConfirmed,
  });

  const pollInterval = tracking ? ACTUALS_POLL_INTERVAL_MS : false;

  // Only resolves the fallback id when the onboarding payload doesn't name a
  // primary assistant; polls just until an id lands (transient failures while
  // the pod restarts would otherwise leave the id — and the flow — unresolved).
  const activeAssistantQuery = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled: open && orgReady && proConfirmed,
    refetchInterval: (query) =>
      query.state.data?.id != null ? false : pollInterval,
    retry: false,
  });
  // The post-confirm onboarding fetch has settled — neither the cold load nor
  // the refetch from the on-open invalidation is in flight. Routing consumes
  // this ("is domain_setup_available safe to route on yet?"), where "not
  // currently fetching" is the right question.
  const onboardingSettled =
    proConfirmed && !onboardingQuery.isPending && !onboardingQuery.isFetching;

  // The onboarding payload names the server-side provisioning target; it wins
  // over the active assistant when the two diverge (multi-assistant orgs). Trust
  // primary_assistant_id only once onboarding has produced a result after this
  // open (dataUpdatedAt >= openedAt, mirroring subscriptionFresh) — not merely
  // "not currently fetching". dataUpdatedAt only moves forward, so the primary
  // survives later background refetches (window-focus, reconnect, invalidation)
  // instead of transiently dropping to the active assistant and pointing the
  // polls (and the actuals snapshot) at the wrong one, while a stale pre-open
  // cached payload is still ignored. Fall back to active until it lands fresh.
  const primaryAssistantFresh =
    proConfirmed &&
    openedAt != null &&
    onboardingQuery.dataUpdatedAt >= openedAt;

  const assistantId =
    (primaryAssistantFresh
      ? onboardingQuery.data?.primary_assistant_id
      : null) ??
    (onboardingQuery.isPending ? null : (activeAssistantQuery.data?.id ?? null));

  // Actuals must track the same assistant the wizard targets — under
  // multi-assistant the active assistant may not be the one being resized.
  const assistantQuery = useQuery({
    ...assistantsRetrieveOptions({ path: { id: assistantId ?? "unresolved" } }),
    enabled: open && orgReady && proConfirmed && assistantId != null,
    refetchInterval: pollInterval,
    retry: false,
  });

  const operationalStatusQuery = useQuery({
    ...assistantsOperationalStatusDetailReadOptions({
      path: { id: assistantId ?? "unresolved" },
    }),
    enabled: open && orgReady && proConfirmed && assistantId != null,
    refetchInterval: pollInterval,
    retry: false,
  });

  const resizeOperationInFlight = isResizeOperationInFlight(
    operationalStatusQuery.data,
  );

  useEffect(() => {
    if (resizeOperationInFlight) setSawOperation(true);
  }, [resizeOperationInFlight]);

  const onboarding = onboardingQuery.data;
  const targets = useMemo<ProvisioningDimensions | null>(() => {
    if (!onboarding) return null;
    return {
      // No machine tier on the package (e.g. Mighty), or a tier this bundle
      // doesn't know, yields no machine target; the machine treats a null
      // dimension as satisfied, so version skew never computes a wrong target.
      machineSize:
        allowedMachineSizesForTier(onboarding.max_machine_tier).at(-1) ?? null,
      storageGib: onboarding.selected_storage_gib ?? null,
    };
  }, [onboarding]);

  const assistant = assistantQuery.data;
  const actuals = useMemo<ProvisioningDimensions | null>(() => {
    if (!assistant) return null;
    return {
      machineSize: assistant.machine_size ?? null,
      storageGib: assistant.provisioned_storage_gib ?? null,
    };
  }, [assistant]);

  const snapshotMatchesAssistant = snapshotAssistantId === assistantId;

  // Freeze the first non-null actuals as the before/after "from" side, keyed to
  // the assistant it describes. When assistantId changes (e.g. a stale primary
  // corrected to the fresh one) the by-id assistant query re-keys, so re-capture
  // the snapshot against the new assistant instead of keeping the previous
  // one's value.
  useEffect(() => {
    if (!open || !actuals) {
      return;
    }
    if (actualsSnapshot != null && snapshotMatchesAssistant) {
      return;
    }
    setActualsSnapshot(actuals);
    setSnapshotAssistantId(assistantId);
  }, [open, actuals, assistantId, actualsSnapshot, snapshotMatchesAssistant]);

  const watchStartedAt = resumedAt ?? proConfirmedAt;
  const msSinceWatchStart =
    watchStartedAt == null ? null : Math.max(0, now - watchStartedAt);
  const { state, softWaiting } = deriveProvisioningState({
    planId: proConfirmed ? "pro" : observedPlanId,
    targets,
    actuals,
    // Only the "from" side captured against the current assistant is valid; a
    // snapshot from a prior target must never drive the before/after verdict.
    initialActuals: snapshotMatchesAssistant ? actualsSnapshot : null,
    resizeOperationInFlight,
    sawOperation,
    msSinceWatchStart,
    confirmExpired,
    serverVerdict,
  });

  const isTerminal = TERMINAL_STATES.includes(state);
  const shouldTrack = open && proConfirmed && !isTerminal;

  useEffect(() => {
    setTracking(shouldTrack);
  }, [shouldTrack]);

  useEffect(() => {
    if (!open || !proConfirmed || isTerminal) return;
    const t = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, [open, proConfirmed, isTerminal]);

  return {
    state,
    softWaiting,
    targets,
    actualsSnapshot,
    assistantId,
    domainSetupAvailable: onboarding?.domain_setup_available,
    onboardingSettled,
    confirmError: !proConfirmed && subscriptionQuery.isError,
    // The onboarding endpoint is platform-side (not the restarting assistant
    // machine), so its failure is surfaced — but only when there's no cached
    // data to keep driving the flow.
    targetsError: proConfirmed && onboardingQuery.isError && !onboarding,
    escapeEligible:
      msSinceWatchStart != null && msSinceWatchStart >= PROVISION_ESCAPE_MS,
    retryConfirm,
    resumeAfterManualApply,
  };
}
