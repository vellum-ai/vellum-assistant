import type { LucideIcon } from "lucide-react";
import { ArrowRight, Check, Coins, Cpu, HardDrive } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
import { SERIF_HEADING_STYLE, type StalledApplyAction } from "./primitives";
import {
  buildResourceChanges,
  type ResourceChangeKey,
} from "./resource-changes";
import { useProvisioningCredits } from "./use-provisioning-credits";
import { useRotatingIndex } from "./use-rotating-index";
import { useHeldPhase } from "./use-held-phase";
import {
  extractOnboardingErrorMessage,
  PROVISION_MIN_DWELL_MS,
  PROVISION_PHASE_MIN_MS,
} from "./utils";

// The mock's takeover tint, matched to the green Vellum creature. No token
// holds this, so it follows the plans-page PAGE_BACKGROUND raw-hex precedent.
export const TAKEOVER_BACKGROUND = "#1D271E";

const CHIP_BACKGROUND =
  "color-mix(in srgb, var(--content-emphasised) 10%, transparent)";

// Above this many applicable resource changes the row rotates one chip at a
// time instead of showing them all together. Two fit the mock's `flex-1` row
// cleanly; a third (machine + storage + credits) is what triggers rotation.
const MAX_CHIPS_IN_ROW = 2;
const RESOURCE_ROTATE_MS = 2500;

const RESOURCE_CHIP_ICON: Record<ResourceChangeKey, LucideIcon> = {
  machine: Cpu,
  storage: HardDrive,
  credits: Coins,
};

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
  /** Test hook — overrides the per-phase minimum; 0 disables the hold. */
  phaseMinMs?: number;
  /** Test hook — overrides the celebration min dwell. */
  dwellMs?: number;
}

/**
 * The user's assistant avatar, centered and oversized as the takeover's focal
 * point. Falls back to a neutral bundled creature (and finally the "V") while
 * the avatar resolves or when none is configured. The idle breathe + reduced
 * -motion gating come from `AnimatedAvatar` inside `ChatAvatar`.
 */
function TakeoverAvatar({
  assistantId,
  resolved,
}: {
  assistantId?: string | null;
  /** The work finished — play the one-shot settle. */
  resolved: boolean;
}) {
  const activeId = useResolvedAssistantsStore.use.activeAssistantId();
  const resolvedId = assistantId ?? activeId;
  const { components, traits, customImageUrl } = useAssistantAvatar(resolvedId);
  const fallbackComponents = useBundledAvatarComponents();
  return (
    <div
      aria-hidden
      className={`flex flex-col items-center ${resolved ? "provision-avatar-resolved" : ""}`}
    >
      <ChatAvatar
        components={components ?? fallbackComponents}
        traits={traits}
        customImageUrl={customImageUrl}
        size={240}
      />
      <div
        className="mt-1 h-5 w-64"
        style={{
          // Decorative avatar drop-shadow; raw rgba is conventional for a CSS shadow.
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
      <h1 className="text-[var(--content-emphasised)]" style={SERIF_HEADING_STYLE}>
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
      className="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5"
      style={{ backgroundColor: CHIP_BACKGROUND }}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
        <Icon
          className="h-3.5 w-3.5 text-[var(--content-tertiary)]"
          aria-hidden="true"
        />
      </span>
      <div className="flex flex-col gap-1 text-left">
        <span className="text-[12px] font-medium leading-tight text-[var(--content-tertiary)]">
          {label}
        </span>
        <span className="flex items-center gap-1.5 text-[14px] font-medium leading-[18px] text-[var(--content-emphasised)]">
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
    <div className="flex w-full max-w-sm flex-wrap items-stretch justify-center gap-2">
      {children}
    </div>
  );
}

/**
 * WAITING/RESIZING resource chips: each changed dimension as a `{current} →
 * {new}` chip (machine/storage from `targets` + `fromSnapshot`, credits from the
 * catalog with a fixed `0` current for the base→pro upgrade). All apply-able
 * chips show together per the mock; once more than `MAX_CHIPS_IN_ROW` apply and
 * motion is allowed, they rotate one at a time on a timed opacity crossfade.
 */
function ResourceChangeChips({
  intent,
  targets,
  fromSnapshot,
}: {
  intent: CheckoutIntent | null;
  targets: ProvisioningDimensions;
  fromSnapshot: ProvisioningDimensions;
}) {
  const creditsLabel = useProvisioningCredits(intent);
  const reduce = useReducedMotion();
  const changes = buildResourceChanges({
    targets,
    fromSnapshot,
    credits: creditsLabel ? { from: "0", to: creditsLabel } : null,
  });
  const rotating = changes.length > MAX_CHIPS_IN_ROW && !reduce;
  const index = useRotatingIndex(changes.length, {
    intervalMs: RESOURCE_ROTATE_MS,
    enabled: rotating,
  });

  if (changes.length === 0) {
    return null;
  }

  if (rotating) {
    const change = changes[index];
    return (
      <ChipRow>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={change.key}
            className="flex flex-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <DimensionChip
              icon={RESOURCE_CHIP_ICON[change.key]}
              label={change.label}
              from={change.from}
              to={change.to}
              done={false}
            />
          </motion.div>
        </AnimatePresence>
      </ChipRow>
    );
  }

  return (
    <ChipRow>
      {changes.map((change) => (
        <DimensionChip
          key={change.key}
          icon={RESOURCE_CHIP_ICON[change.key]}
          label={change.label}
          from={change.from}
          to={change.to}
          done={false}
        />
      ))}
    </ChipRow>
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
              ? `${fromSnapshot.storageGib} GB`
              : undefined
          }
          to={`${targets.storageGib} GB`}
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
  phaseMinMs = PROVISION_PHASE_MIN_MS,
}: ProvisioningStateProps) {
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

  const dwelling = celebrating && resolved;
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
      className="relative flex h-full min-h-[420px] w-full flex-col items-center justify-center gap-10 px-6 py-10 text-center"
      style={{ backgroundColor: TAKEOVER_BACKGROUND }}
    >
      <TakeoverAvatar assistantId={assistantId} resolved={resolved} />
      {/* Keyed so each phase replays the entrance instead of swapping its copy
          in place. WAITING and RESIZING render identical copy, so they share a
          key and don't retrigger. The min-height anchors the block: phases
          carry different chip counts, and without it the whole centred group
          jumps as they swap. */}
      <div
        key={phaseKey}
        className="flex min-h-[120px] w-full flex-col items-center gap-8 [animation:onboarding-step-in_420ms_ease-out] motion-reduce:[animation:none]"
      >
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
    if (heldState === "CONFIRMING") {
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

    if (heldState === "WAITING" || heldState === "RESIZING") {
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
          <ResourceChangeChips
            intent={intent}
            targets={targets}
            fromSnapshot={fromSnapshot}
          />
          {escapeButton()}
        </>
      );
    }

    if (heldState === "DONE") {
      return (
        <>
          <Copy status="All done!" />
          <TargetChips targets={targets} fromSnapshot={fromSnapshot} done />
        </>
      );
    }

    if (heldState === "NOT_APPLICABLE") {
      return <Copy status="Your plan is ready" />;
    }

    if (heldState === "STALLED") {
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

    if (heldState === "CONFIRM_TIMEOUT") {
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
