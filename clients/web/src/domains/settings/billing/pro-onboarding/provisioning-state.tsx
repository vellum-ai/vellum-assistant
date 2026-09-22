import { useEffect, useRef, useState } from "react";

import type { MachineSizeEnum } from "@/generated/api/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { MACHINE_TIER_LABEL } from "@/lib/billing/machine-sizes";
import type { ProvisioningDimensionFlags } from "@/lib/billing/provisioning-targets";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import type {
  ProvisioningDimensions,
  ProvisioningStateKind,
} from "./provisioning-machine";
import { SERIF_HEADING_STYLE } from "./primitives";
import {
  buildResourceChanges,
  type CreditsChipContent,
  type ResourceChangeKey,
} from "./resource-changes";
import { takeoverCopy, type TakeoverDirection } from "./takeover-copy";
import { UpgradeMetrics, type UpgradeMetric } from "./upgrade-metrics";
import { UpgradeStream } from "./upgrade-stream";
import {
  useProvisioningCredits,
  useResizeCreditsChange,
  type CreditsChange,
  type CreditTierChange,
} from "./use-provisioning-credits";
import { useHeldPhase } from "./use-held-phase";
import {
  extractOnboardingErrorMessage,
  PROVISION_MIN_DWELL_MS,
  PROVISION_PHASE_MIN_MS,
} from "./utils";

/**
 * The takeover's ground: white, whatever the app's theme, so the character
 * stream reads the way it does on the welcome screen. The modal's exit
 * sheet paints the same value, so leaving the takeover never cross-fades a
 * second colour. The takeover scopes itself to the light theme's tokens for
 * the same reason: dark and velvet set the content colours near white,
 * which on this ground would be pale text on paper.
 */
export const PROVISIONING_SURFACE = "#ffffff";

export interface ProvisioningStateProps {
  state: ProvisioningStateKind;
  /** Which way the change goes; selects the phase copy. */
  direction?: TakeoverDirection;
  /** Softens the waiting sub-copy once the grace period has elapsed. */
  softWaiting: boolean;
  /** The checkout selection stashed before the Stripe redirect. */
  intent: CheckoutIntent | null;
  /**
   * Resize mode only: the credit tiers an in-place change moves between,
   * captured by the plans page before the change landed. `null` or `undefined`
   * means the change left the bundle alone and the credits row is dropped.
   * Distinct from `intent` on purpose: resize mode never reads the checkout
   * intent, so a stale one can't leak in here.
   */
  creditsChange?: CreditTierChange | null;
  targets: ProvisioningDimensions;
  /** Pre-resize actuals rendered as the "from" side of the metrics. */
  fromSnapshot: ProvisioningDimensions;
  /**
   * Machine size a package with no machine tier settles at, so the resulting
   * downsize still gets a row. Display only; it never feeds the targets.
   */
  machineFloor?: MachineSizeEnum | null;
  /**
   * Per-dimension provisioning progress. A dimension that has landed shows
   * the green check on its row. Omitted, every dimension stays pending until
   * the phase itself resolves.
   */
  landed?: ProvisioningDimensionFlags;
  celebrating: boolean;
  onCelebrationEnd: () => void;
  escapeAvailable: boolean;
  onEscape: () => void;
  /** Reports the phase actually on screen, which lags `state` by the hold. */
  onPhaseChange?: (phase: ProvisioningStateKind) => void;
  /**
   * ensure-provisioned failure held by the hook; with STALLED it selects the
   * snag variant.
   */
  kickError?: unknown;
  confirm: { onRetry: () => void; onGoToBilling: () => void };
  /** Test hook — overrides the per-phase minimum; 0 disables the hold. */
  phaseMinMs?: number;
  /** Test hook — overrides the celebration min dwell. */
  dwellMs?: number;
}

function Copy({ status, caption }: { status: string; caption?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <h1
        className="text-[var(--content-emphasised)]"
        style={SERIF_HEADING_STYLE}
      >
        {status}
      </h1>
      {caption && (
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="max-w-sm text-[var(--content-secondary)]"
        >
          {caption}
        </Typography>
      )}
    </div>
  );
}

/**
 * Whether a dimension has arrived. Credits apply the moment the plan change
 * is accepted, with nothing to roll out, so their row is landed from first
 * paint; machine and storage each report their own progress.
 */
function dimensionDone(
  key: ResourceChangeKey,
  landed: ProvisioningDimensionFlags | undefined,
): boolean {
  if (key === "credits") {
    return true;
  }
  return landed?.[key] === true;
}

type SettingsTranslate = ReturnType<typeof useTranslation<"settings">>["t"];

/**
 * The credits row's strings. No amount may render: each side names its
 * bundle by catalog label, the no-bundle side reads as the "No extra usage"
 * sentinel, and a side the catalog can't label is left unstated: an unstated
 * from-side just drops the arrow, an unstated to-side drops the whole row
 * rather than asserting a bundle it cannot name. The row label is "Usage" so
 * the row never introduces credits as a concept.
 */
function creditsContent(
  credits: CreditsChange | null,
  t: SettingsTranslate,
): CreditsChipContent | null {
  if (credits == null) {
    return null;
  }
  const noExtraUsage = t("provisioningState.noExtraUsage");
  const to = credits.toLabel === null ? noExtraUsage : credits.toLabel;
  if (to == null) {
    return null;
  }
  return {
    label: t("provisioningState.usageLabel"),
    from: credits.fromLabel === null ? noExtraUsage : credits.fromLabel,
    to,
  };
}

/**
 * The takeover's metrics: every applicable change as a `{current} -> {new}`
 * row (machine and storage from `targets`, `fromSnapshot` and the
 * display-only `machineFloor`; credits as `creditsContent`'s bundle names).
 *
 * All of them render together from the first paint of the wait, each
 * carrying its own progress: a green check once its dimension arrives.
 * Showing them one at a time would hide the resize the user is actually
 * waiting on behind a dimension that was never in doubt.
 *
 * Each row states its progress in `sr-only` text, which is what a user gets
 * by navigating the row at any point in the wait. Discoverable text alone is
 * silent on change, so the row also carries a polite live region naming the
 * dimensions that read complete. It names them rather than announcing a bare
 * status word, and it holds whatever already reads complete at first paint
 * as its baseline so credits (complete from the start) never announces.
 *
 * `allDone` is the terminal phase, where the state itself is the signal for
 * every dimension. `creditsOnly` narrows the row to the credit move, for a
 * phase that owes no machine or storage work at all.
 */
function ResourceChangeMetrics({
  intent,
  creditsChange,
  targets,
  fromSnapshot,
  machineFloor,
  landed,
  allDone = false,
  creditsOnly = false,
}: {
  intent: CheckoutIntent | null;
  creditsChange?: CreditTierChange | null;
  targets: ProvisioningDimensions;
  fromSnapshot: ProvisioningDimensions;
  machineFloor?: MachineSizeEnum | null;
  landed?: ProvisioningDimensionFlags;
  allDone?: boolean;
  creditsOnly?: boolean;
}) {
  const { t } = useTranslation("settings");
  // Checkout reads the stashed intent, an in-place change carries its own
  // tiers, and a takeover runs in exactly one of those modes, so at most one of
  // these resolves.
  const checkoutCredits = useProvisioningCredits(intent);
  const inPlaceCredits = useResizeCreditsChange(creditsChange);
  const credits = checkoutCredits ?? inPlaceCredits;
  const built = buildResourceChanges({
    targets,
    fromSnapshot,
    machineFloor,
    credits: creditsContent(credits, t),
  });
  const changes = creditsOnly
    ? built.filter((change) => change.key === "credits")
    : built;

  const completed = changes
    .filter((change) => allDone || dimensionDone(change.key, landed))
    .map((change) => change.label)
    .join(", ");
  const [completedAtFirstPaint] = useState(completed);
  const announcement =
    completed === completedAtFirstPaint
      ? ""
      : t("provisioningState.dimensionsComplete", { dimensions: completed });

  if (changes.length === 0) {
    return null;
  }

  const items: UpgradeMetric[] = changes.map((change) => {
    const done = allDone || dimensionDone(change.key, landed);
    return {
      key: change.key,
      label: change.label,
      from: change.from ?? null,
      to: change.to,
      landed: done,
      status: done
        ? t("provisioningState.statusComplete")
        : t("provisioningState.statusPending"),
    };
  });

  return (
    <>
      <UpgradeMetrics
        items={items}
        testId="resource-chips"
        toWord={t("provisioningState.srOnlyTo")}
      />
      <p aria-live="polite" className="sr-only" data-testid="chip-announcement">
        {announcement}
      </p>
    </>
  );
}

/**
 * CONFIRMING metrics: derived from the stashed intent before any API data
 * lands, target-only, with no progress to claim. The one exception is the
 * custom intent's bundle: its wording is the bundle's catalog label rather
 * than a credit count, so it waits on the plan catalog (usually already
 * cached by the page that stashed the intent) and is simply absent until
 * that resolves.
 */
function IntentMetrics({ intent }: { intent: CheckoutIntent }) {
  const { t } = useTranslation("settings");
  const credits = useProvisioningCredits(
    intent.kind === "custom" ? intent : null,
  );
  if (intent.kind === "package") {
    const name =
      intent.packageKey.charAt(0).toUpperCase() + intent.packageKey.slice(1);
    return (
      <UpgradeMetrics
        testId="resource-chips"
        items={[
          {
            key: "package",
            label: t("provisioningState.packageLabel"),
            from: null,
            to: name,
          },
        ]}
      />
    );
  }
  const items: UpgradeMetric[] = [];
  if (intent.machineTier != null) {
    items.push({
      key: "machine",
      label: t("provisioningState.machineLabel"),
      from: null,
      to: MACHINE_TIER_LABEL[intent.machineTier] ?? intent.machineTier,
    });
  }
  if (intent.storageTier != null) {
    items.push({
      key: "storage",
      label: t("provisioningState.storageLabel"),
      from: null,
      to: intent.storageTier.toUpperCase(),
    });
  }
  if (intent.creditTier != null && credits?.toLabel != null) {
    items.push({
      key: "credits",
      label: t("provisioningState.usageLabel"),
      from: null,
      to: credits.toLabel,
    });
  }
  if (items.length === 0) {
    return null;
  }
  return <UpgradeMetrics testId="resource-chips" items={items} />;
}

/**
 * The full-bleed screen the billing wizard opens on while the platform rolls
 * the purchased machine and storage out: the status copy in the serif, the
 * metrics of the change beneath it, and the character stream flowing past.
 * Where there is room beside the copy the stream goes around it and the
 * copy sits left of centre; on a phone the copy takes the top of the screen
 * and the stream the rest.
 *
 * The stream keeps moving through every phase but a stall, where motion
 * that promises progress under copy that says there is none would be worse
 * than stillness.
 */
export function ProvisioningState({
  state,
  direction,
  softWaiting,
  intent,
  creditsChange,
  targets,
  fromSnapshot,
  machineFloor,
  landed,
  celebrating,
  onCelebrationEnd,
  escapeAvailable,
  onEscape,
  onPhaseChange,
  kickError,
  confirm,
  dwellMs = PROVISION_MIN_DWELL_MS,
  phaseMinMs = PROVISION_PHASE_MIN_MS,
}: ProvisioningStateProps) {
  const { t } = useTranslation("settings");
  const copy = takeoverCopy(direction);
  const onCelebrationEndRef = useRef(onCelebrationEnd);
  useEffect(() => {
    onCelebrationEndRef.current = onCelebrationEnd;
  }, [onCelebrationEnd]);

  // Everything below renders from the held phase, not the live one, so a phase
  // the user couldn't have read never reaches the screen. The celebration dwell
  // keys off it too — otherwise the wizard could advance past "All done!"
  // before it was shown.
  const heldState = useHeldPhase(state, phaseMinMs);
  const resolved = heldState === "DONE" || heldState === "NOT_APPLICABLE";
  const phaseKey = heldState === "RESIZING" ? "WAITING" : heldState;

  // The wizard locks itself against the phase on screen, not the live one.
  const onPhaseChangeRef = useRef(onPhaseChange);
  useEffect(() => {
    onPhaseChangeRef.current = onPhaseChange;
  }, [onPhaseChange]);
  useEffect(() => {
    onPhaseChangeRef.current?.(heldState);
  }, [heldState]);

  const dwelling = celebrating && resolved;
  useEffect(() => {
    if (!dwelling) {
      return;
    }
    const t = setTimeout(() => onCelebrationEndRef.current(), dwellMs);
    return () => clearTimeout(t);
  }, [dwelling, dwellMs]);

  const mobile = useIsMobile();
  const streamPaused = heldState === "STALLED";

  /* Keyed so each phase replays the entrance instead of swapping its copy in
     place. WAITING and RESIZING render identical copy, so they share a key
     and don't retrigger. */
  const phase = (
    <div
      key={phaseKey}
      className="relative z-10 flex w-full flex-col items-center gap-6 [animation:onboarding-step-in_420ms_ease-out] motion-reduce:[animation:none]"
    >
      {renderPhase()}
    </div>
  );

  if (mobile) {
    return (
      <div
        data-testid="provisioning-takeover"
        data-theme="light"
        className="relative flex h-full min-h-[420px] w-full flex-col overflow-hidden text-center"
        style={{ backgroundColor: PROVISIONING_SURFACE }}
      >
        <div className="px-6 pb-8 pt-16">{phase}</div>
        <div className="relative min-h-0 flex-1">
          <UpgradeStream
            className="absolute inset-0"
            layout="below"
            paused={streamPaused}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="provisioning-takeover"
      data-theme="light"
      className="relative flex h-full min-h-[420px] w-full flex-col items-center justify-center overflow-hidden px-6 py-10 text-center"
      style={{ backgroundColor: PROVISIONING_SURFACE }}
    >
      <UpgradeStream
        className="absolute inset-0"
        layout="around"
        paused={streamPaused}
      />
      {/* A right margin on the block moves its centre left by half of it,
          out from under the stream's bend. */}
      <div className="relative z-10 mr-[16%] flex w-full max-w-2xl flex-col items-center">
        {phase}
      </div>
    </div>
  );

  function escapeButton(label = t("provisioningState.continueInBackground")) {
    if (!escapeAvailable) {
      return null;
    }
    return (
      <Button
        variant="ghost"
        data-testid="provisioning-escape"
        onClick={onEscape}
      >
        {label}
      </Button>
    );
  }

  /** The metrics row; `allDone` is the terminal phase forcing every check on. */
  function metrics({
    allDone = false,
    creditsOnly = false,
  }: { allDone?: boolean; creditsOnly?: boolean } = {}) {
    return (
      <ResourceChangeMetrics
        intent={intent}
        creditsChange={creditsChange}
        targets={targets}
        fromSnapshot={fromSnapshot}
        machineFloor={machineFloor}
        landed={landed}
        allDone={allDone}
        creditsOnly={creditsOnly}
      />
    );
  }

  function renderPhase() {
    if (heldState === "CONFIRMING") {
      return (
        <>
          <Copy
            status={copy.confirmingStatus}
            caption={t("provisioningState.confirmingCaption")}
          />
          {intent && <IntentMetrics intent={intent} />}
          {escapeButton()}
        </>
      );
    }

    if (heldState === "WAITING" || heldState === "RESIZING") {
      return (
        <>
          <Copy
            status={copy.waitingStatus}
            caption={
              softWaiting
                ? t("provisioningState.waitingCaptionLong")
                : t("provisioningState.waitingCaptionShort")
            }
          />
          {metrics()}
          {escapeButton()}
        </>
      );
    }

    if (heldState === "DONE") {
      return (
        <>
          <Copy status={t("provisioningState.allDoneStatus")} />
          {metrics({ allDone: true })}
        </>
      );
    }

    if (heldState === "NOT_APPLICABLE") {
      // Terminal for a change that owes no provisioning, a credit-only switch
      // above all, so the credit move is its one statement of what changed. No
      // machine or storage work is outstanding here by construction, so a
      // resource row could only report a dimension that stayed put.
      return (
        <>
          <Copy status={t("provisioningState.planReadyStatus")} />
          {metrics({ allDone: true, creditsOnly: true })}
        </>
      );
    }

    if (heldState === "STALLED") {
      // With no captured reconcile error the wait is just slow — say so
      // honestly. Only an actual failure escalates to the "snag" variant with
      // the mapped error and a retry-flavoured escape label.
      const snag = kickError != null;
      return (
        <>
          <Copy
            status={
              snag ? copy.snagStatus : t("provisioningState.takingLongerStatus")
            }
            caption={
              snag
                ? extractOnboardingErrorMessage(
                    kickError,
                    copy.snagCaption,
                    direction,
                  )
                : t("provisioningState.stalledCaption")
            }
          />
          {metrics()}
          {snag
            ? escapeButton(t("provisioningState.retryInBackground"))
            : escapeButton()}
        </>
      );
    }

    if (heldState === "CONFIRM_TIMEOUT") {
      return (
        <>
          <Copy
            status={copy.confirmTimeoutStatus}
            caption={copy.confirmTimeoutCaption}
          />
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="outlined"
              data-testid="onboarding-go-to-billing"
              onClick={confirm.onGoToBilling}
            >
              {t("provisioningState.goToBilling")}
            </Button>
            <Button
              variant="primary"
              data-testid="onboarding-retry"
              onClick={confirm.onRetry}
            >
              {t("provisioningState.tryAgain")}
            </Button>
          </div>
        </>
      );
    }

    return null;
  }
}
