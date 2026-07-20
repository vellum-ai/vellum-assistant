import { AlertCircle, Check, Cpu, HardDrive, PartyPopper } from "lucide-react";
import { useEffect, useRef } from "react";

import type { MachineTierEnum } from "@/generated/api/types.gen";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { SIZE_DESCRIPTION, SIZE_LABEL } from "@/lib/billing/machine-sizes";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import type {
    ProvisioningDimensions,
    ProvisioningStateKind,
} from "./provisioning-machine";
import { TimeoutState } from "./error-states";
import { GlowSpinner, IconBadge, ResourceCard } from "./primitives";
import { extractOnboardingErrorMessage, PROVISION_MIN_DWELL_MS } from "./utils";

export interface ProvisioningStateProps {
  state: ProvisioningStateKind;
  /** Softens the waiting sub-copy once the grace period has elapsed. */
  softWaiting: boolean;
  /** The checkout selection stashed before the Stripe redirect. */
  intent: CheckoutIntent | null;
  targets: ProvisioningDimensions;
  /** Pre-resize actuals rendered as the "from" side of the resource cards. */
  fromSnapshot: ProvisioningDimensions;
  celebrating: boolean;
  onCelebrationEnd: () => void;
  escapeAvailable: boolean;
  onEscape: () => void;
  stalledAction: { onApply: () => void; pending: boolean; error: unknown };
  confirm: { expired: boolean; onRetry: () => void; onGoToBilling: () => void };
  /** Test hook — overrides the celebration min dwell. */
  dwellMs?: number;
}

const MACHINE_TIER_LABEL: Record<MachineTierEnum, string> = {
  medium: "Medium",
  large: "Large",
  xl: "XL",
};

function intentChipLabels(intent: CheckoutIntent): string[] {
  if (intent.kind === "package") {
    const name =
      intent.packageKey.charAt(0).toUpperCase() + intent.packageKey.slice(1);
    return [`${name} package`];
  }
  const labels: string[] = [];
  if (intent.machineTier != null) {
    labels.push(`${MACHINE_TIER_LABEL[intent.machineTier]} machine`);
  }
  if (intent.storageTier != null) {
    labels.push(`${intent.storageTier.toUpperCase()} storage`);
  }
  if (intent.creditTier != null) {
    labels.push(`${intent.creditTier.replace("credits_", "")} credits`);
  }
  return labels;
}

function IntentChips({ intent }: { intent: CheckoutIntent }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      {intentChipLabels(intent).map((label) => (
        <span
          key={label}
          className="rounded-full border border-[var(--border-element)] bg-[var(--surface-base)] px-2.5 py-1 text-label-small-default text-[var(--content-secondary)]"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function ResourceCardList({
  targets,
  fromSnapshot,
}: {
  targets: ProvisioningDimensions;
  fromSnapshot: ProvisioningDimensions;
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      {targets.machineSize != null && (
        <ResourceCard
          icon={Cpu}
          label="Machine"
          from={
            fromSnapshot.machineSize != null
              ? SIZE_LABEL[fromSnapshot.machineSize]
              : "—"
          }
          fromDetail={
            fromSnapshot.machineSize != null
              ? SIZE_DESCRIPTION[fromSnapshot.machineSize]
              : undefined
          }
          to={SIZE_LABEL[targets.machineSize]}
          toDetail={SIZE_DESCRIPTION[targets.machineSize]}
        />
      )}
      {targets.storageGib != null && (
        <ResourceCard
          icon={HardDrive}
          label="Storage"
          from={
            fromSnapshot.storageGib != null
              ? `${fromSnapshot.storageGib} GiB`
              : "—"
          }
          to={`${targets.storageGib} GiB`}
        />
      )}
    </div>
  );
}

function Headline({ title, body }: { title: string; body?: string }) {
  return (
    <div className="space-y-1.5">
      <Typography variant="title-small" as="h1">
        {title}
      </Typography>
      {body && (
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="text-[var(--content-secondary)]"
        >
          {body}
        </Typography>
      )}
    </div>
  );
}

export function ProvisioningState({
  state,
  softWaiting,
  intent,
  targets,
  fromSnapshot,
  celebrating,
  onCelebrationEnd,
  escapeAvailable,
  onEscape,
  stalledAction,
  confirm,
  dwellMs = PROVISION_MIN_DWELL_MS,
}: ProvisioningStateProps) {
  const onCelebrationEndRef = useRef(onCelebrationEnd);
  useEffect(() => {
    onCelebrationEndRef.current = onCelebrationEnd;
  }, [onCelebrationEnd]);

  const dwelling =
    celebrating && (state === "DONE" || state === "NOT_APPLICABLE");
  useEffect(() => {
    if (!dwelling) {
      return;
    }
    const t = setTimeout(() => onCelebrationEndRef.current(), dwellMs);
    return () => clearTimeout(t);
  }, [dwelling, dwellMs]);

  if (
    state === "CONFIRM_TIMEOUT" ||
    (state === "CONFIRMING" && confirm.expired)
  ) {
    return (
      <TimeoutState
        message="Your payment went through safely — we're still confirming your upgrade with Stripe. This can take a minute."
        onRetry={confirm.onRetry}
        onGoToBilling={confirm.onGoToBilling}
      />
    );
  }

  return (
    <div
      className="flex min-h-[320px] flex-col items-center justify-center gap-4 px-6 py-10 text-center"
      style={{ animation: "onboarding-step-in 350ms ease-out" }}
    >
      {renderPhase()}
      {escapeAvailable && (
        <Button
          variant="ghost"
          data-testid="provisioning-escape"
          onClick={onEscape}
        >
          Continue in the background
        </Button>
      )}
    </div>
  );

  function renderPhase() {
    if (state === "CONFIRMING") {
      return (
        <>
          <GlowSpinner />
          <Headline
            title="Payment confirmed — setting up your upgrade…"
            body="We're getting your new plan's resources ready. This usually takes a few seconds."
          />
          {intent && (
            <div style={{ animation: "welcome-reveal 600ms ease-out 150ms both" }}>
              <IntentChips intent={intent} />
            </div>
          )}
        </>
      );
    }

    if (state === "WAITING" || state === "RESIZING") {
      return (
        <>
          <GlowSpinner />
          <Headline
            title={
              state === "RESIZING"
                ? "Resizing your assistant…"
                : "Setting up your new resources…"
            }
            body={
              softWaiting
                ? "Still working — this can take a few minutes. Everything is on track."
                : "This usually takes under a minute."
            }
          />
          <ResourceCardList targets={targets} fromSnapshot={fromSnapshot} />
          <Notice tone="neutral" className="w-full text-left">
            Your assistant is restarting itself — it may look offline for a
            minute.
          </Notice>
        </>
      );
    }

    if (state === "DONE") {
      return (
        <>
          <div style={{ animation: "welcome-reveal 600ms ease-out both" }}>
            <IconBadge icon={PartyPopper} />
          </div>
          <div style={{ animation: "welcome-reveal 600ms ease-out 150ms both" }}>
            <Headline
              title="Your upgrade is ready"
              body="Your assistant is back online with its new resources."
            />
          </div>
        </>
      );
    }

    if (state === "NOT_APPLICABLE") {
      return (
        <>
          <div style={{ animation: "welcome-reveal 600ms ease-out both" }}>
            <IconBadge icon={Check} />
          </div>
          <div style={{ animation: "welcome-reveal 600ms ease-out 150ms both" }}>
            <Headline title="Your plan is ready" />
          </div>
          <Notice tone="neutral" className="w-full text-left">
            No resource changes were needed — you&apos;re all set.
          </Notice>
        </>
      );
    }

    if (state === "STALLED") {
      return (
        <>
          <IconBadge icon={AlertCircle} tone="warning" />
          <Headline title="One more step" />
          <Notice tone="warning" className="w-full text-left">
            We couldn&apos;t finish this automatically. Apply the changes below
            to finish setting up your upgrade.
          </Notice>
          <ResourceCardList targets={targets} fromSnapshot={fromSnapshot} />
          {stalledAction.error != null && (
            <Notice tone="error" className="w-full text-left">
              {extractOnboardingErrorMessage(
                stalledAction.error,
                "Couldn't apply changes. Please try again.",
              )}
            </Notice>
          )}
          <Button
            variant="primary"
            data-testid="provisioning-apply"
            disabled={stalledAction.pending}
            onClick={stalledAction.onApply}
          >
            Apply &amp; Restart
          </Button>
        </>
      );
    }

    return null;
  }
}
