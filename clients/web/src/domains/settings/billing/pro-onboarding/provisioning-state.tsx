import type { LucideIcon } from "lucide-react";
import { ArrowRight, Check, Cpu, HardDrive } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { MACHINE_TIER_LABEL, SIZE_LABEL } from "@/lib/billing/machine-sizes";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import type {
    ProvisioningDimensions,
    ProvisioningStateKind,
} from "./provisioning-machine";
import type { StalledApplyAction } from "./primitives";
import { extractOnboardingErrorMessage, PROVISION_MIN_DWELL_MS } from "./utils";

// The mock's takeover tint, matched to the green Vellum creature. No token
// holds this, so it follows the plans-page PAGE_BACKGROUND raw-hex precedent.
const TAKEOVER_BACKGROUND = "#1D271E";

const CHIP_BACKGROUND =
  "color-mix(in srgb, var(--content-emphasised) 10%, transparent)";

export interface ProvisioningStateProps {
  state: ProvisioningStateKind;
  /** Softens the waiting sub-copy once the grace period has elapsed. */
  softWaiting: boolean;
  /** The checkout selection stashed before the Stripe redirect. */
  intent: CheckoutIntent | null;
  targets: ProvisioningDimensions;
  /** Pre-resize actuals rendered as the "from" side of the resource chips. */
  fromSnapshot: ProvisioningDimensions;
  celebrating: boolean;
  onCelebrationEnd: () => void;
  /** The assistant being provisioned — drives the takeover avatar. */
  assistantId?: string | null;
  escapeAvailable: boolean;
  onEscape: () => void;
  stalledAction: StalledApplyAction;
  confirm: { onRetry: () => void; onGoToBilling: () => void };
  /** Test hook — overrides the celebration min dwell. */
  dwellMs?: number;
}

/**
 * The user's assistant avatar, centered and oversized as the takeover's focal
 * point. Falls back to a neutral bundled creature (and finally the "V") while
 * the avatar resolves or when none is configured. The idle breathe + reduced
 * -motion gating come from `AnimatedAvatar` inside `ChatAvatar`.
 */
function TakeoverAvatar({ assistantId }: { assistantId?: string | null }) {
  const activeId = useResolvedAssistantsStore.use.activeAssistantId();
  const resolvedId = assistantId ?? activeId;
  const { components, traits, customImageUrl } = useAssistantAvatar(resolvedId);
  const fallbackComponents = useBundledAvatarComponents();
  return (
    <div aria-hidden className="flex flex-col items-center">
      <ChatAvatar
        components={components ?? fallbackComponents}
        traits={traits}
        customImageUrl={customImageUrl}
        size={240}
      />
      <div
        className="mt-1 h-4 w-40"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0, 0, 0, 0.45), transparent 70%)",
        }}
      />
    </div>
  );
}

function Copy({ status, caption }: { status: string; caption?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <h1
        className="text-[var(--content-emphasised)]"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: "32px",
          fontWeight: 400,
          letterSpacing: "0.64px",
          lineHeight: 1.2,
        }}
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

function DimensionChip({
  icon: Icon,
  label,
  from,
  to,
  done = false,
}: {
  icon: LucideIcon;
  label: string;
  from?: string;
  to: string;
  done?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg px-3 py-2"
      style={{ backgroundColor: CHIP_BACKGROUND }}
    >
      <Icon
        className="h-6 w-6 shrink-0 text-[var(--content-secondary)]"
        aria-hidden="true"
      />
      <div className="flex flex-col text-left">
        <span className="text-[12px] leading-tight text-[var(--content-tertiary)]">
          {label}
        </span>
        <span className="flex items-center gap-1.5 text-[14px] leading-tight text-[var(--content-emphasised)]">
          {from && (
            <>
              <span>{from}</span>
              <ArrowRight
                className="h-3 w-3 shrink-0 text-[var(--content-tertiary)]"
                aria-hidden="true"
              />
            </>
          )}
          <span>{to}</span>
          {done && (
            <Check
              className="h-3.5 w-3.5 shrink-0 text-[var(--system-positive-strong)]"
              aria-hidden="true"
            />
          )}
        </span>
      </div>
    </div>
  );
}

function TextChip({ label }: { label: string }) {
  return (
    <span
      className="rounded-lg px-3 py-2 text-[14px] text-[var(--content-emphasised)]"
      style={{ backgroundColor: CHIP_BACKGROUND }}
    >
      {label}
    </span>
  );
}

function ChipRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {children}
    </div>
  );
}

/** CONFIRMING chips: derived from the stashed intent before any API data lands. */
function IntentChips({ intent }: { intent: CheckoutIntent }) {
  if (intent.kind === "package") {
    const name =
      intent.packageKey.charAt(0).toUpperCase() + intent.packageKey.slice(1);
    return (
      <ChipRow>
        <TextChip label={`${name} package`} />
      </ChipRow>
    );
  }
  return (
    <ChipRow>
      {intent.machineTier != null && (
        <DimensionChip
          icon={Cpu}
          label="Machine"
          to={MACHINE_TIER_LABEL[intent.machineTier] ?? intent.machineTier}
        />
      )}
      {intent.storageTier != null && (
        <DimensionChip
          icon={HardDrive}
          label="Storage"
          to={intent.storageTier.toUpperCase()}
        />
      )}
      {intent.creditTier != null && (
        <TextChip
          label={`${intent.creditTier.replace("credits_", "")} credits`}
        />
      )}
    </ChipRow>
  );
}

/** Machine/Storage from→to chips, driven by the resolved provisioning targets. */
function TargetChips({
  targets,
  fromSnapshot,
  done = false,
}: {
  targets: ProvisioningDimensions;
  fromSnapshot: ProvisioningDimensions;
  done?: boolean;
}) {
  return (
    <ChipRow>
      {targets.machineSize != null && (
        <DimensionChip
          icon={Cpu}
          label="Machine"
          from={
            !done && fromSnapshot.machineSize != null
              ? SIZE_LABEL[fromSnapshot.machineSize]
              : undefined
          }
          to={SIZE_LABEL[targets.machineSize]}
          done={done}
        />
      )}
      {targets.storageGib != null && (
        <DimensionChip
          icon={HardDrive}
          label="Storage"
          from={
            !done && fromSnapshot.storageGib != null
              ? `${fromSnapshot.storageGib} GiB`
              : undefined
          }
          to={`${targets.storageGib} GiB`}
          done={done}
        />
      )}
    </ChipRow>
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
  assistantId,
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

  return (
    <div
      data-theme="dark"
      className="relative flex h-full min-h-[420px] w-full flex-col items-center justify-center gap-6 px-6 py-10 text-center"
      style={{ backgroundColor: TAKEOVER_BACKGROUND }}
    >
      <TakeoverAvatar assistantId={assistantId} />
      <div className="flex flex-col items-center gap-2 [animation:onboarding-step-in_350ms_ease-out] motion-reduce:[animation:none]">
        {renderPhase()}
      </div>
    </div>
  );

  function escapeButton() {
    if (!escapeAvailable) {
      return null;
    }
    return (
      <Button
        variant="ghost"
        data-testid="provisioning-escape"
        onClick={onEscape}
      >
        Continue in the background
      </Button>
    );
  }

  function renderPhase() {
    if (state === "CONFIRMING") {
      return (
        <>
          <Copy
            status="Confirming your upgrade…"
            caption="This might take a couple seconds."
          />
          {intent && <IntentChips intent={intent} />}
          {escapeButton()}
        </>
      );
    }

    if (state === "WAITING" || state === "RESIZING") {
      return (
        <>
          <Copy
            status="Upgrading your assistant…"
            caption={
              softWaiting
                ? "Still working — this can take a minute or two."
                : "This might take a couple seconds."
            }
          />
          <TargetChips targets={targets} fromSnapshot={fromSnapshot} />
          {escapeButton()}
        </>
      );
    }

    if (state === "DONE") {
      return (
        <>
          <Copy status="All done!" />
          <TargetChips targets={targets} fromSnapshot={fromSnapshot} done />
        </>
      );
    }

    if (state === "NOT_APPLICABLE") {
      return <Copy status="Your plan is ready" />;
    }

    if (state === "STALLED") {
      return (
        <>
          <Copy
            status="We couldn't finish this automatically"
            caption={extractOnboardingErrorMessage(
              stalledAction.error,
              "Apply the changes below to finish setting up your upgrade.",
            )}
          />
          <TargetChips targets={targets} fromSnapshot={fromSnapshot} />
          <Button
            variant="primary"
            data-testid="provisioning-apply"
            disabled={stalledAction.pending}
            onClick={stalledAction.onApply}
          >
            Apply &amp; Restart
          </Button>
          {escapeButton()}
        </>
      );
    }

    if (state === "CONFIRM_TIMEOUT") {
      return (
        <>
          <Copy
            status="Still confirming your upgrade"
            caption="Your payment went through safely — this can take a minute."
          />
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="outlined"
              data-testid="onboarding-go-to-billing"
              onClick={confirm.onGoToBilling}
            >
              Go to billing
            </Button>
            <Button
              variant="primary"
              data-testid="onboarding-retry"
              onClick={confirm.onRetry}
            >
              Try again
            </Button>
          </div>
        </>
      );
    }

    return null;
  }
}
