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
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  MachineTierEnum,
  OperationalStatus,
} from "@/generated/api/types.gen";

import {
  deriveProvisioningState,
  type ProvisioningDimensions,
  type ProvisioningServerVerdict,
  type ProvisioningStateKind,
} from "./provisioning-machine";
import {
  allowedMachineSizesForTier,
  PRO_POLL_INTERVAL_MS,
  PRO_POLL_TIMEOUT_MS,
} from "./utils";

const ACTUALS_POLL_INTERVAL_MS = 2000;
/** Re-derive elapsed-time transitions (grace/stall) between poll responses. */
const CLOCK_TICK_MS = 1000;

const TERMINAL_STATES: readonly ProvisioningStateKind[] = [
  "DONE",
  "NOT_APPLICABLE",
  "STALLED",
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
  /** The CONFIRMING-phase subscription fetch failed. */
  confirmError: boolean;
  /** The post-confirm onboarding fetch failed with no cached data. */
  targetsError: boolean;
  /** The CONFIRMING-phase poll timed out without observing plan_id "pro". */
  confirmExpired: boolean;
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
  const [confirmExpired, setConfirmExpired] = useState(false);
  const [confirmGeneration, setConfirmGeneration] = useState(0);
  const [proConfirmedAt, setProConfirmedAt] = useState<number | null>(null);
  // Stall-clock re-base set by resumeAfterManualApply; proConfirmedAt otherwise.
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [sawOperation, setSawOperation] = useState(false);
  const [actualsSnapshot, setActualsSnapshot] =
    useState<ProvisioningDimensions | null>(null);
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
    setProConfirmedAt(null);
    setResumedAt(null);
    setSawOperation(false);
    setActualsSnapshot(null);
    setTracking(true);
  }, [open]);

  // Drop pre-checkout caches so we never confirm on a stale plan_id or read a
  // pre-upgrade tier ceiling as the resize target.
  useEffect(() => {
    if (!open) return;
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
    enabled: open && !proConfirmed,
  });

  const observedPlanId = subscriptionQuery.data?.plan_id ?? null;

  useEffect(() => {
    if (!open || proConfirmed || observedPlanId !== "pro") return;
    const confirmedAt = Date.now();
    setProConfirmedAt(confirmedAt);
    setNow(confirmedAt);
  }, [open, proConfirmed, observedPlanId]);

  useEffect(() => {
    if (!open || proConfirmed) return;
    const t = setTimeout(() => setConfirmExpired(true), PRO_POLL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [open, proConfirmed, confirmGeneration]);

  const retryConfirm = useCallback(() => {
    setConfirmExpired(false);
    setConfirmGeneration((g) => g + 1);
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
    enabled: open && proConfirmed,
  });

  const pollInterval = tracking ? ACTUALS_POLL_INTERVAL_MS : false;

  const activeAssistantQuery = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled: open && proConfirmed,
    refetchInterval: pollInterval,
    retry: false,
  });
  const assistantId = activeAssistantQuery.data?.id ?? null;

  const operationalStatusQuery = useQuery({
    ...assistantsOperationalStatusDetailReadOptions({
      path: { id: assistantId ?? "unresolved" },
    }),
    enabled: open && proConfirmed && assistantId != null,
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
    const tier = (onboarding.max_machine_tier ?? null) as MachineTierEnum | null;
    return {
      // No machine tier on the package (e.g. Mighty) → no machine target.
      machineSize: tier
        ? (allowedMachineSizesForTier(tier).at(-1) ?? null)
        : null,
      storageGib: onboarding.selected_storage_gib ?? null,
    };
  }, [onboarding]);

  const assistant = activeAssistantQuery.data;
  const actuals = useMemo<ProvisioningDimensions | null>(() => {
    if (!assistant) return null;
    return {
      machineSize: assistant.machine_size ?? null,
      storageGib: assistant.provisioned_storage_gib ?? null,
    };
  }, [assistant]);

  useEffect(() => {
    if (!open || !actuals) return;
    setActualsSnapshot((prev) => prev ?? actuals);
  }, [open, actuals]);

  const watchStartedAt = resumedAt ?? proConfirmedAt;
  const { state, softWaiting } = deriveProvisioningState({
    planId: proConfirmed ? "pro" : observedPlanId,
    targets,
    actuals,
    initialActuals: actualsSnapshot,
    resizeOperationInFlight,
    sawOperation,
    msSinceWatchStart:
      watchStartedAt == null ? null : Math.max(0, now - watchStartedAt),
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
    confirmError: !proConfirmed && subscriptionQuery.isError,
    // The onboarding endpoint is platform-side (not the restarting assistant
    // machine), so its failure is surfaced — but only when there's no cached
    // data to keep driving the flow.
    targetsError: proConfirmed && onboardingQuery.isError && !onboarding,
    confirmExpired,
    retryConfirm,
    resumeAfterManualApply,
  };
}
