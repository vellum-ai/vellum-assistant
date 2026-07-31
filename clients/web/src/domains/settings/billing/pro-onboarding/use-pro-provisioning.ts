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
 *
 * On top of the observation it also *acts*: the moment the subscription first
 * reports Pro it fires the idempotent ensure-provisioned reconcile endpoint
 * automatically, and `kickProvisioning` fires the same reconcile on demand, so
 * a webhook that never fired (or whose resize was lost) still gets
 * provisioned. The returned verdict feeds the state machine's `serverVerdict`
 * slot; the endpoint failing never blocks the flow — the polling above
 * converges on its own. A reconcile failure from any source is held in
 * `ensureError` (exposed as `kickError`) so the takeover can honestly surface
 * the ≥90s snag variant; any later success clears it. The reconcile carries no
 * pending flag.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  hashKey,
  notifyManager,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  assistantsActiveRetrieveOptions,
  assistantsOperationalStatusDetailReadOptions,
  assistantsRetrieveOptions,
  organizationsBillingSubscriptionOnboardingEnsureProvisionedCreateMutation,
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { MachineSizeEnum } from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  MACHINE_FLOOR_SIZE,
  machineCeilingForTier,
  machineSizeRank,
} from "@/lib/billing/machine-sizes";
import {
  dimensionTargetsMet,
  isEntitlementRaceVerdict,
  isResizeOperationInFlight,
  type ProvisioningDimensionFlags,
  resizeDimensionsInFlight,
} from "@/lib/billing/provisioning-targets";
import { useOrganizationStore } from "@/stores/organization-store";

import {
  deriveProvisioningState,
  type ProvisioningDimensions,
  type ProvisioningServerVerdict,
  type ProvisioningStateKind,
  targetsMet,
} from "./provisioning-machine";
import {
  ENSURE_PROVISIONED_RACE_RETRY_MS,
  PRO_POLL_INTERVAL_MS,
  PRO_POLL_TIMEOUT_MS,
  PROVISION_ESCAPE_MS,
  PROVISION_VERDICT_RECHECK_MS,
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

/**
 * The operational-status fetch-start count at the moment each dimension was
 * first seen to meet what the takeover displays for it, keyed to the assistant
 * those counts describe. The per-dimension analogue of `targetsMetAt`, feeding
 * the presentation-only landed flags.
 */
interface DimensionMetLatch {
  assistantId: string | null;
  machine: number | null;
  storage: number | null;
}

const NO_DIMENSIONS_MET: DimensionMetLatch = {
  assistantId: null,
  machine: null,
  storage: null,
};

export interface UseProProvisioningOptions {
  open: boolean;
  /**
   * Whether the change being watched can lower a resource ceiling, which is the
   * only thing that stops met targets from standing in for "nothing was owed".
   * Absent reads as false, which is what post-checkout onboarding always is.
   */
  canLowerResources?: boolean;
  /** Test hook: how often to re-ask a verdict-only wait for a terminal answer. */
  verdictRecheckMs?: number;
}

export interface ProProvisioningResult {
  state: ProvisioningStateKind;
  softWaiting: boolean;
  targets: ProvisioningDimensions | null;
  /** First actuals observed, frozen — the "from" side of before/after cards. */
  actualsSnapshot: ProvisioningDimensions | null;
  /**
   * Machine size a package with no machine tier settles at, mirroring the
   * server's ceiling for a null tier. Display only, so the takeover can show
   * the resulting downsize; it never feeds `targets`, where a non-null machine
   * size would demand non-null actuals and hang a fresh hatch.
   */
  machineFloor: MachineSizeEnum | null;
  /**
   * Per-dimension provisioning progress: a dimension has landed once what the
   * takeover displays for it is met, it has no resize in flight, and a status
   * fetch that started after that dimension read met has come back.
   * The machine dimension is measured against the size it is headed for (the
   * purchased size, or `machineFloor` for a machine-less package) in the
   * direction it is moving, because the purchased targets only ever grow and a
   * downsize would otherwise read met before the pod shrank.
   *
   * Presentation only, for per-chip progress; terminal completion still flows
   * exclusively through `deriveProvisioningState`, which can complete the flow
   * before any status reading postdates the actuals. A dimension may therefore
   * still read pending in DONE, where the state is itself the signal.
   *
   * A machine resize supersedes a storage one in the single per-assistant
   * marker, so storage can read landed while the machine rollout is still
   * running. That is honest: the storage grow was accepted, and the machine
   * flag keeps its own row pending until the rollout converges.
   */
  landed: ProvisioningDimensionFlags;
  /**
   * The assistant provisioning targets: the onboarding payload's primary
   * assistant when named, else the active assistant. Drives the actuals and
   * operational-status polls.
   */
  assistantId: string | null;
  /**
   * Whether the wizard may offer the domain/email step: the org holds the
   * managed-email entitlement AND the onboarding payload names an assistant to
   * attach the domain to. Both halves ride the same payload, so this is
   * `undefined` until it loads.
   */
  domainStepAvailable: boolean | undefined;
  /**
   * The post-confirm onboarding fetch has settled — neither the cold load nor
   * the refetch from the on-open invalidation is in flight, so
   * `domainStepAvailable` is safe to route on.
   */
  onboardingSettled: boolean;
  /** The CONFIRMING-phase subscription fetch failed. */
  confirmError: boolean;
  /** The post-confirm onboarding fetch failed with no cached data. */
  targetsError: boolean;
  /**
   * The watch has run long enough (without resolving) that the "continue in
   * the background" escape hatch may be offered. Re-bases with the stall clock
   * after a successful `kickProvisioning` resume.
   */
  escapeEligible: boolean;
  /** Reset the confirm timeout and re-poll the subscription. */
  retryConfirm: () => void;
  /**
   * Fire-and-forget "escape" kick: fires the idempotent ensure-provisioned
   * reconcile (grow-only, in-flight-guarded, so a repeat never double-fires a
   * resize) and re-bases the stall clock on success so observation resumes.
   * Carries no pending flag, so a hung call can never strand later UI. Used
   * when closing the takeover into the background.
   */
  kickProvisioning: () => void;
  /**
   * Latest ensure-provisioned failure from any source; cleared by a later
   * success. Drives the ≥90s snag variant on the takeover.
   */
  kickError: unknown;
}

export function useProProvisioning({
  open,
  canLowerResources = false,
  verdictRecheckMs = PROVISION_VERDICT_RECHECK_MS,
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
  // Stall-clock re-base set by a successful kick reconcile; proConfirmedAt
  // otherwise.
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  // Latest adopted ensure-provisioned verdict; null while the endpoint hasn't
  // answered (or answered something we deliberately don't adopt), in which
  // case the machine falls back to pure client-side inference.
  const [serverVerdict, setServerVerdict] =
    useState<ProvisioningServerVerdict | null>(null);
  // When the actuals were first seen to meet the targets. Under a provisional
  // verdict (`started` / `in_progress`) the flow may only go terminal once the
  // operational-status query has read the world at least once after this
  // instant — see the completion rules in `deriveProvisioningState`. The
  // verdict's own arrival is deliberately NOT the anchor: `started` merely
  // queues the resize on a worker, so a status read right after it can precede
  // the marker's creation entirely.
  const [targetsMetAt, setTargetsMetAt] = useState<number | null>(null);
  // The assistant that latch describes. Without it, switching to a different
  // provisioning target that *also* already meets the targets would never flip
  // `currentTargetsMet` false, so the previous assistant's timestamp would
  // survive — and a status reading for the new assistant that merely postdates
  // it could confirm a rollout nobody has observed. Mirrors how the actuals
  // snapshot is keyed to `snapshotAssistantId`.
  const [targetsMetAssistantId, setTargetsMetAssistantId] = useState<
    string | null
  >(null);
  // The same anchor per dimension, for the landed flags.
  const [dimensionMetAtFetch, setDimensionMetAtFetch] =
    useState<DimensionMetLatch>(NO_DIMENSIONS_MET);
  // Latest reconcile failure from any source (auto/escape); cleared by a later
  // success — see runEnsureProvisioned.
  const [ensureError, setEnsureError] = useState<unknown>(null);
  const [raceRetryScheduled, setRaceRetryScheduled] = useState(false);
  // Fire-once-per-open guard for the automatic reconcile. A ref (not state) so
  // it can't be lost to a re-render between the check and the call, and it
  // outlives the confirm-generation counter that retryConfirm bumps.
  const ensureRequestedRef = useRef(false);
  // At most one automatic re-call for the no_active_pro entitlement race.
  const ensureRaceRetriedRef = useRef(false);
  // Identifies the wizard open a reconcile belongs to. Bumped on close, so a
  // response that lands after the reset is discarded instead of writing a
  // verdict or an error into the next open's session.
  const ensureGenerationRef = useRef(0);
  const [sawOperation, setSawOperation] = useState(false);
  // The assistant whose marker was watched. Until the onboarding payload names
  // a primary the hook polls the active-assistant fallback, so a marker can be
  // observed on one assistant and the watch then re-keyed to another. An
  // unkeyed latch would carry that unrelated marker across as evidence that a
  // downsize on the new assistant had already rolled out.
  const [sawOperationAssistantId, setSawOperationAssistantId] = useState<
    string | null
  >(null);
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
    if (open) {
      return;
    }
    setConfirmExpired(false);
    setConfirmGeneration(0);
    setOpenedAt(null);
    setProConfirmedAt(null);
    setResumedAt(null);
    setSawOperation(false);
    setSawOperationAssistantId(null);
    setActualsSnapshot(null);
    setSnapshotAssistantId(null);
    setTracking(true);
    setServerVerdict(null);
    setTargetsMetAt(null);
    setTargetsMetAssistantId(null);
    setDimensionMetAtFetch(NO_DIMENSIONS_MET);
    setEnsureError(null);
    setRaceRetryScheduled(false);
    ensureRequestedRef.current = false;
    ensureRaceRetriedRef.current = false;
    ensureGenerationRef.current += 1;
  }, [open]);

  // Refetch pre-checkout caches on open. Invalidation keeps serving cached
  // data while the refetch is in flight, so `openedAt` fences confirm
  // latching to data that actually landed after this open.
  useEffect(() => {
    if (!open) {
      return;
    }
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
      if (planId === "pro" || confirmExpired) {
        return false;
      }
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
    if (!open || proConfirmed || observedPlanId !== "pro") {
      return;
    }
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

  /** Re-base the stall/grace clock so observation starts over. */
  const resumeWatch = useCallback(() => {
    const t = Date.now();
    setResumedAt(t);
    setNow(t);
  }, []);

  const ensureProvisionedMutation = useMutation(
    organizationsBillingSubscriptionOnboardingEnsureProvisionedCreateMutation(),
  );
  const { mutate: ensureProvisioned } = ensureProvisionedMutation;

  const runEnsureProvisioned = useCallback(
    (source: "auto" | "escape") => {
      // The open this call belongs to. Both callbacks drop out when the wizard
      // has since closed, so a late response can't drive a later session.
      const generation = ensureGenerationRef.current;
      ensureProvisioned(
        {},
        {
          onSuccess: (data) => {
            if (generation !== ensureGenerationRef.current) {
              return;
            }
            setEnsureError(null);
            // A race reply is not an answer: adopting it would park the wizard
            // in a terminal state with an unprovisioned assistant. Leave the
            // verdict null (pure inference keeps running) and re-ask once —
            // the race resolves in a beat.
            if (isEntitlementRaceVerdict(data)) {
              if (!ensureRaceRetriedRef.current) {
                ensureRaceRetriedRef.current = true;
                setRaceRetryScheduled(true);
                // A re-ask is already queued, so observation may resume.
                if (source === "escape") {
                  resumeWatch();
                }
              } else {
                // Dead end: the verdict is deliberately not adopted, nothing
                // was queued, and the once-per-open re-ask is spent. Re-basing
                // the stall clock here would drop the user out of STALLED with
                // no resize running and nothing said. Hold the state and
                // explain, regardless of source, so a repeat dead end surfaces
                // why — carrying the server's own reason so the snag copy
                // names the right one.
                setEnsureError({ error: data.reason ?? "no_active_pro" });
              }
            } else {
              setServerVerdict(data.state);
              if (source === "escape") {
                resumeWatch();
              }
            }
          },
          onError: (error) => {
            if (generation !== ensureGenerationRef.current) {
              return;
            }
            // 503 (submission couldn't be queued) or a network blip: nothing
            // was queued and nothing is broken — the actuals polling still
            // converges, so the flow never blocks on this. The error is held
            // for the ≥90s snag variant on the takeover and cleared by any
            // later success, so a failure from any source is captured alike.
            setEnsureError(error);
          },
        },
      );
    },
    [ensureProvisioned, resumeWatch],
  );

  // Reconcile once per wizard open, at the moment the subscription poll first
  // reports Pro. The ref guard survives re-renders and the confirm-generation
  // retry counter; `proConfirmed` itself only latches once per open.
  useEffect(() => {
    if (!open || !orgReady || !proConfirmed) {
      return;
    }
    if (ensureRequestedRef.current) {
      return;
    }
    ensureRequestedRef.current = true;
    runEnsureProvisioned("auto");
  }, [open, orgReady, proConfirmed, runEnsureProvisioned]);

  useEffect(() => {
    if (!raceRetryScheduled) {
      return;
    }
    // Pinned to the open that scheduled it, so a pending timer never issues a
    // call on behalf of a later one.
    const generation = ensureGenerationRef.current;
    const t = setTimeout(() => {
      setRaceRetryScheduled(false);
      if (generation !== ensureGenerationRef.current) {
        return;
      }
      runEnsureProvisioned("auto");
    }, ENSURE_PROVISIONED_RACE_RETRY_MS);
    return () => clearTimeout(t);
  }, [raceRetryScheduled, runEnsureProvisioned]);

  // Fire-and-forget escape kick: fires the reconcile with no pending flag, so a
  // hung escape-fired call can't strand later UI.
  const kickProvisioning = useCallback(
    () => runEnsureProvisioned("escape"),
    [runEnsureProvisioned],
  );

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
  // Onboarding data is fresh once it has been fetched during this open
  // (dataUpdatedAt at or after openedAt, mirroring subscriptionFresh), not
  // merely served from a pre-open cache. A failed on-open refetch can leave
  // stale cached data with isPending/isFetching both false, so freshness — not
  // just "not currently fetching" — is what routing and the primary-assistant
  // target both require. dataUpdatedAt only moves forward, so this stays true
  // across later background refetches (window-focus, reconnect, invalidation).
  const onboardingFresh =
    proConfirmed &&
    openedAt != null &&
    onboardingQuery.dataUpdatedAt >= openedAt;

  // The post-confirm onboarding fetch has settled: fresh for this open, and
  // neither the cold load nor the on-open-invalidation refetch is in flight.
  // Routing consumes this ("is `domainStepAvailable` safe to route on yet?"),
  // so it must not settle on a stale pre-checkout payload.
  const onboardingSettled =
    onboardingFresh &&
    !onboardingQuery.isPending &&
    !onboardingQuery.isFetching;

  // The onboarding payload names the server-side provisioning target; it wins
  // over the active assistant when the two diverge (multi-assistant orgs). Trust
  // primary_assistant_id only once onboarding is fresh — otherwise the primary
  // would transiently drop to the active assistant and point the polls (and the
  // actuals snapshot) at the wrong one, and a stale pre-open cached payload is
  // ignored. Fall back to active until it lands fresh.

  const assistantId =
    (onboardingFresh ? onboardingQuery.data?.primary_assistant_id : null) ??
    (onboardingQuery.isPending
      ? null
      : (activeAssistantQuery.data?.id ?? null));

  // Actuals must track the same assistant the wizard targets — under
  // multi-assistant the active assistant may not be the one being resized.
  const assistantQuery = useQuery({
    ...assistantsRetrieveOptions({ path: { id: assistantId ?? "unresolved" } }),
    enabled: open && orgReady && proConfirmed && assistantId != null,
    refetchInterval: pollInterval,
    retry: false,
  });

  const operationalStatusOptions = assistantsOperationalStatusDetailReadOptions(
    { path: { id: assistantId ?? "unresolved" } },
  );
  const operationalStatusQuery = useQuery({
    ...operationalStatusOptions,
    enabled: open && orgReady && proConfirmed && assistantId != null,
    refetchInterval: pollInterval,
    retry: false,
  });

  // How many operational-status fetches have *started*, and which of those
  // starts the most recent successful reading belongs to. The query cache
  // dispatches `fetch` as a request begins and `success` when one lands, both
  // synchronously, so a subscription counts starts, not completions.
  //
  // That distinction is the whole fence below. A request already out when a
  // dimension latches read the world before the resize marker existed, and no
  // time its answer is later stored under changes that. Since only starts move
  // the count, such a request can never advance it past a latch taken while it
  // was in flight, so where the latch falls relative to the render is moot.
  //
  // The ref is the live count, which is what effects read: a count captured
  // during render is already stale if a request begins before the effect runs.
  // The state is the render-visible half. It advances only on a successful
  // reading, so a status query stuck erroring withholds the flags rather than
  // guessing, and only ever forward, so a landed flag never blinks off when
  // the next poll goes out. Neither is reset with the wizard: both are
  // monotonic and the latch is re-taken against the live count.
  const statusFetchStartsRef = useRef(0);
  const [lastReadFetchStart, setLastReadFetchStart] = useState(0);
  const statusQueryHash = hashKey(operationalStatusOptions.queryKey);
  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        event.query.queryHash !== statusQueryHash
      ) {
        return;
      }
      if (event.action.type === "fetch") {
        statusFetchStartsRef.current += 1;
      } else if (event.action.type === "success" && !event.action.manual) {
        // Which start this reading belongs to has to be read here, before a
        // later one can move the count. Publishing it through the cache's own
        // notify queue lands it in the same React commit as the reading.
        const readStart = statusFetchStartsRef.current;
        // A marker only counts as this takeover's evidence when it arrives in a
        // reading that landed here: the query cache outlives the takeover and
        // the lifecycle poller keeps it warm, so its stored value can be a
        // marker from an earlier resize on this same assistant. Reading the
        // marker off the delivered payload rather than off rendered state ties
        // the evidence to the reading that carried it, so neither a cached
        // value nor a later re-render can stand in for one.
        const watchedMarker =
          open && isResizeOperationInFlight(event.action.data);
        notifyManager.schedule(() => {
          setLastReadFetchStart(readStart);
          if (watchedMarker) {
            setSawOperation(true);
            setSawOperationAssistantId(assistantId);
          }
        });
      }
    });
  }, [queryClient, statusQueryHash, open, assistantId]);

  const resizeOperationInFlight = isResizeOperationInFlight(
    operationalStatusQuery.data,
  );

  // `sawOperation` is latched from the reading itself, in the cache listener
  // above, so nothing here needs to re-observe it. It stays keyed to the
  // assistant it was watched on, because the fallback-to-primary re-key can
  // move the watch mid-open.
  const sawOperationMatchesAssistant = sawOperationAssistantId === assistantId;

  const onboarding = onboardingQuery.data;
  const targets = useMemo<ProvisioningDimensions | null>(() => {
    if (!onboarding) {
      return null;
    }
    return {
      // No machine tier on the package (e.g. Mighty), or a tier this bundle
      // doesn't know, yields no machine target; the machine treats a null
      // dimension as satisfied, so version skew never computes a wrong target.
      machineSize: machineCeilingForTier(onboarding.max_machine_tier),
      storageGib: onboarding.selected_storage_gib ?? null,
    };
  }, [onboarding]);

  // Mirrors the server's machine ceiling for a package with no tier.
  const machineFloor: MachineSizeEnum | null =
    onboarding != null && onboarding.max_machine_tier == null
      ? MACHINE_FLOOR_SIZE
      : null;

  // The managed-email entitlement alone doesn't make the domain step offerable:
  // the domain POST re-resolves the caller's primary assistant server-side and
  // rejects with 409 when there is none, so the payload must also name one. The
  // active-assistant fallback that resolves `assistantId` is deliberately not
  // consulted here — the server ignores any client-supplied id for that write.
  const domainStepAvailable = onboarding
    ? onboarding.domain_setup_available &&
      onboarding.primary_assistant_id != null
    : undefined;

  const assistant = assistantQuery.data;
  const actuals = useMemo<ProvisioningDimensions | null>(() => {
    if (!assistant) {
      return null;
    }
    return {
      machineSize: assistant.machine_size ?? null,
      storageGib: assistant.provisioned_storage_gib ?? null,
    };
  }, [assistant]);

  const snapshotMatchesAssistant = snapshotAssistantId === assistantId;

  // What the takeover displays as met, per dimension. `dimensionTargetsMet`
  // answers the purchased targets, which only ever grow, while the takeover
  // also displays downsizes: a machine-less package has no machine target at
  // all, so null reads met by definition, and a lower one reads met while the
  // pod is still larger. Either way the displayed change would report complete
  // before anything moved. So judge the machine dimension against where it is
  // actually headed (the purchased size when the package names one, the floor
  // it settles at otherwise) in the direction the change goes from the size it
  // started at. The floor stays out of `targets` for the reason on
  // `machineFloor`.
  const displayTargetsMet = useMemo<ProvisioningDimensionFlags>(() => {
    const met = dimensionTargetsMet(targets, actuals);
    const destination = targets?.machineSize ?? machineFloor;
    if (destination == null) {
      return met;
    }
    const actualMachine = actuals?.machineSize ?? null;
    if (actualMachine == null) {
      return { ...met, machine: false };
    }
    // Before the snapshot latches, and whenever it describes another assistant,
    // the actuals in hand are themselves the first reading, which narrows the
    // comparison to "already there" rather than guessing a direction.
    const startedFrom =
      (snapshotMatchesAssistant ? actualsSnapshot?.machineSize : null) ??
      actualMachine;
    const downsizing =
      machineSizeRank(destination) < machineSizeRank(startedFrom);
    return {
      ...met,
      machine: downsizing
        ? machineSizeRank(actualMachine) <= machineSizeRank(destination)
        : machineSizeRank(actualMachine) >= machineSizeRank(destination),
    };
  }, [
    targets,
    actuals,
    actualsSnapshot,
    snapshotMatchesAssistant,
    machineFloor,
  ]);

  // Latch the instant the actuals first read as meeting the targets. The
  // platform creates the resize marker BEFORE it persists the effective sizes,
  // so any operational-status reading taken after this instant is guaranteed to
  // see that marker — or its retirement. Cleared if the actuals fall back below
  // the targets (a re-keyed assistant), so the anchor always describes the
  // observation the completion check is about to be made against.
  const currentTargetsMet = targetsMet(targets, actuals);
  const targetsMetMatchesAssistant = targetsMetAssistantId === assistantId;
  useEffect(() => {
    if (!open) {
      return;
    }
    if (currentTargetsMet) {
      setTargetsMetAt((prev) =>
        prev != null && targetsMetMatchesAssistant ? prev : Date.now(),
      );
      setTargetsMetAssistantId(assistantId);
    } else {
      setTargetsMetAt(null);
      setTargetsMetAssistantId(null);
    }
  }, [open, currentTargetsMet, assistantId, targetsMetMatchesAssistant]);

  // The same latch per dimension, on the same write-order guarantee: a status
  // reading taken after a dimension read met is the one guaranteed to find that
  // dimension's marker, or find it retired. Keyed to the provisioning assistant
  // for the reason above.
  //
  // What is recorded is the fetch-start count rather than an instant, because
  // the question the fence asks is when a reading *began*, and that is the only
  // thing that says whether it could have seen the marker.
  const dimensionMetMatchesAssistant =
    dimensionMetAtFetch.assistantId === assistantId;
  useEffect(() => {
    if (!open) {
      return;
    }
    const startedFetches = statusFetchStartsRef.current;
    setDimensionMetAtFetch((prev) => {
      const carried =
        prev.assistantId === assistantId ? prev : NO_DIMENSIONS_MET;
      const machine = displayTargetsMet.machine
        ? (carried.machine ?? startedFetches)
        : null;
      const storage = displayTargetsMet.storage
        ? (carried.storage ?? startedFetches)
        : null;
      if (
        prev.assistantId === assistantId &&
        prev.machine === machine &&
        prev.storage === storage
      ) {
        return prev;
      }
      return { assistantId, machine, storage };
    });
  }, [open, displayTargetsMet, assistantId]);

  // Pairs the same questions the state machine pairs globally, per dimension.
  // Met-ness alone would not do: the platform persists the effective sizes at
  // resize acceptance, before the pod restarts, so a dimension reads met
  // mid-rollout. Nor would met-ness plus the marker, because the assistant and
  // status queries poll independently: in the window where the assistant poll
  // holds the persisted sizes and the status query still holds its pre-resize
  // reading, a flag would land and the next poll would take it back.
  //
  // These flags are fenced more strictly than the terminal
  // `statusObservedSinceTargetsMet` gate below, which compares `dataUpdatedAt`
  // against its own latch. That is a result-storage time, so it also counts a
  // fetch that was already out. But that gate is one-way: reaching a terminal
  // state stops the poll, so a slightly early completion is absorbed and never
  // visibly reverses. These flags render continuously, so the same false
  // positive shows a chip checking off and then regressing to a spinner. That
  // asymmetry is why the stricter fence lives here and not there.
  const landed = useMemo<ProvisioningDimensionFlags>(() => {
    const inFlight = resizeDimensionsInFlight(operationalStatusQuery.data);
    // The reading in hand belongs to a fetch that started after this dimension
    // latched, so it is the first one that could have seen the marker.
    const readSinceMet = (metAtFetch: number | null) =>
      metAtFetch != null &&
      dimensionMetMatchesAssistant &&
      lastReadFetchStart > metAtFetch;
    return {
      machine:
        displayTargetsMet.machine &&
        !inFlight.machine &&
        readSinceMet(dimensionMetAtFetch.machine),
      storage:
        displayTargetsMet.storage &&
        !inFlight.storage &&
        readSinceMet(dimensionMetAtFetch.storage),
    };
  }, [
    displayTargetsMet,
    dimensionMetAtFetch,
    dimensionMetMatchesAssistant,
    lastReadFetchStart,
    operationalStatusQuery.data,
  ]);

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
  // Only a change that never lowers the ceilings keeps "targets met" and
  // "nothing to provision" equivalent. One that can lower them meets its
  // targets before anything has moved.
  const targetsProveNoop = !canLowerResources;
  const { state, softWaiting } = deriveProvisioningState({
    planId: proConfirmed ? "pro" : observedPlanId,
    targets,
    actuals,
    // Only the "from" side captured against the current assistant is valid; a
    // snapshot from a prior target must never drive the before/after verdict.
    initialActuals: snapshotMatchesAssistant ? actualsSnapshot : null,
    resizeOperationInFlight,
    // Same rule as the snapshot: a marker watched on a prior target says
    // nothing about this one, and under a downward change it is the only
    // evidence the completion gate accepts.
    sawOperation: sawOperation && sawOperationMatchesAssistant,
    msSinceWatchStart,
    confirmExpired,
    serverVerdict,
    // A successful status fetch always advances `dataUpdatedAt`, so this is
    // "we have read the operational status since the actuals reached the
    // targets". A status query stuck erroring never advances it, which
    // correctly withholds completion rather than guessing.
    // The latch must also still describe the assistant being provisioned —
    // otherwise the render before the re-keying effect runs could confirm
    // against the previous target's timestamp.
    statusObservedSinceTargetsMet:
      targetsMetAt != null &&
      targetsMetMatchesAssistant &&
      operationalStatusQuery.dataUpdatedAt > targetsMetAt,
    targetsProveNoop,
  });

  const isTerminal = TERMINAL_STATES.includes(state);
  const shouldTrack = open && proConfirmed && !isTerminal;

  useEffect(() => {
    setTracking(shouldTrack);
  }, [shouldTrack]);

  useEffect(() => {
    if (!open || !proConfirmed || isTerminal) {
      return;
    }
    const t = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, [open, proConfirmed, isTerminal]);

  // Re-ask the reconcile while a change that can lower the ceilings waits on a
  // verdict that only says a rollout began. Such a change meets its targets
  // from the first render, so the marker is the one thing that can complete it,
  // and the 2s polls can miss a rollout entirely if it finishes between them or
  // if they error while the pod restarts. The server checks the marker and the
  // targets together, so re-asking is the only terminal answer available; the
  // alternative is a spinner running to the stall clock on a change that
  // already succeeded. A marker we did watch needs none of this.
  const awaitingVerdictWithoutMarker =
    !targetsProveNoop &&
    (serverVerdict === "started" || serverVerdict === "in_progress") &&
    !(sawOperation && sawOperationMatchesAssistant);
  useEffect(() => {
    if (!open || !proConfirmed || isTerminal || !awaitingVerdictWithoutMarker) {
      return;
    }
    const t = setInterval(() => runEnsureProvisioned("auto"), verdictRecheckMs);
    return () => clearInterval(t);
  }, [
    open,
    proConfirmed,
    isTerminal,
    awaitingVerdictWithoutMarker,
    verdictRecheckMs,
    runEnsureProvisioned,
  ]);

  return {
    state,
    softWaiting,
    targets,
    actualsSnapshot,
    machineFloor,
    landed,
    assistantId,
    domainStepAvailable,
    onboardingSettled,
    confirmError: !proConfirmed && subscriptionQuery.isError,
    // The onboarding endpoint is platform-side (not the restarting assistant
    // machine), so its failure is surfaced — but only when there's no data this
    // open can drive on. A pre-open cached payload doesn't count: routing waits
    // on `onboardingFresh`, so a failed on-open refetch that leaves only stale
    // data would otherwise stall the takeover with nothing shown.
    targetsError:
      proConfirmed &&
      onboardingQuery.isError &&
      (!onboarding || !onboardingFresh),
    escapeEligible:
      msSinceWatchStart != null && msSinceWatchStart >= PROVISION_ESCAPE_MS,
    retryConfirm,
    kickProvisioning,
    kickError: ensureError,
  };
}
