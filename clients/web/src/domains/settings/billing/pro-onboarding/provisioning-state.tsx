import type { LucideIcon } from "lucide-react";
import { ArrowRight, Check, Coins, Cpu, HardDrive } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { MACHINE_TIER_LABEL, SIZE_LABEL } from "@/lib/billing/machine-sizes";
import { SURFACE_GROUND } from "@/utils/avatar-tone";
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
import { TakeoverBackdrop } from "./takeover-backdrop";
import { useProvisioningCredits } from "./use-provisioning-credits";
import { useTakeoverSurface } from "./use-takeover-surface";
import { useRotatingIndex } from "./use-rotating-index";
import { useHeldPhase } from "./use-held-phase";
import {
  extractOnboardingErrorMessage,
  PROVISION_MIN_DWELL_MS,
  PROVISION_PHASE_MIN_MS,
} from "./utils";

// The takeover's paint, published as a custom property on the modal so the
// takeover and the sheet that covers it on the way out resolve one value. The
// fallback is the hue-neutral ground the surface holds until the avatar
// resolves. It carries no space after the comma — happy-dom's inline-style
// parser drops the whole declaration otherwise, so the tests can't see it.
export const TAKEOVER_SURFACE_VAR = "--takeover-surface";
export const TAKEOVER_SURFACE = `var(${TAKEOVER_SURFACE_VAR},${SURFACE_GROUND})`;

const CHIP_BACKGROUND =
  "color-mix(in srgb, var(--content-emphasised) 10%, transparent)";

// Above this many applicable resource changes the row rotates one chip at a
// time instead of showing them all together. Two fit the mock's `flex-1` row
// cleanly; a third (machine + storage + credits) is what triggers rotation.
const MAX_CHIPS_IN_ROW = 2;
const RESOURCE_ROTATE_MS = 2500;

// The takeover avatar's resting size, and how much bigger it stands once the
// upgrade lands — the mock's 244px → 346px pair. Growth is a transform, so the
// SVG scales without re-rendering at a second size.
const AVATAR_SIZE = 240;
const AVATAR_GROWTH = 1.414;

// The stage reserves the grown height from first paint, so the takeover needs
// `size * AVATAR_GROWTH + 309` of viewport before the phase block underneath —
// which carries the escape hatch and the stalled retry — starts to clip. Step
// the creature down instead of pushing those actions off a short screen.
const AVATAR_SIZE_STEPS: Array<{ minHeight: number; size: number }> = [
  { minHeight: 680, size: AVATAR_SIZE },
  { minHeight: 600, size: 184 },
];
const AVATAR_SIZE_MIN = 132;

function avatarSizeForHeight(height: number): number {
  for (const step of AVATAR_SIZE_STEPS) {
    if (height >= step.minHeight) {
      return step.size;
    }
  }
  return AVATAR_SIZE_MIN;
}

function useTakeoverAvatarSize(): number {
  const [size, setSize] = useState(() =>
    avatarSizeForHeight(
      typeof window === "undefined" ? Infinity : window.innerHeight,
    ),
  );
  useEffect(() => {
    const onResize = () => setSize(avatarSizeForHeight(window.innerHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

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
  /** Reports the phase actually on screen, which lags `state` by the hold. */
  onPhaseChange?: (phase: ProvisioningStateKind) => void;
  stalledAction: StalledApplyAction;
  confirm: { onRetry: () => void; onGoToBilling: () => void };
  /** Test hook — overrides the per-phase minimum; 0 disables the hold. */
  phaseMinMs?: number;
  /** Test hook — overrides the celebration min dwell. */
  dwellMs?: number;
}

/**
 * What the creature is doing, derived from the phase it is rendering. One
 * gesture at three amplitudes — a strain loop while the machine works, the
 * same crouch-and-push at full size once it lands — so the ending reads as the
 * rep that finally succeeded rather than an unrelated flourish.
 *
 * `settling` is the 30s mark, where the caption already concedes the wait. It
 * de-escalates rather than pushing harder: the copy says settle in, so the
 * creature does. `stalled` stops entirely, because motion that promises
 * progress under copy that says there is none is worse than stillness.
 */
type AvatarMode = "idle" | "working" | "settling" | "stalled" | "grown";

const AVATAR_MODE_CLASS: Record<AvatarMode, string> = {
  idle: "",
  working: " is-working",
  settling: " is-settling",
  stalled: " is-stalled",
  grown: " is-evolved",
};

function avatarModeFor(
  state: ProvisioningStateKind,
  softWaiting: boolean,
): AvatarMode {
  if (state === "DONE" || state === "NOT_APPLICABLE") {
    return "grown";
  }
  if (state === "STALLED") {
    return "stalled";
  }
  if (state === "WAITING" || state === "RESIZING") {
    return softWaiting ? "settling" : "working";
  }
  // CONFIRMING and CONFIRM_TIMEOUT are both waits on Stripe, not on the
  // machine — straining there would claim work that isn't happening.
  return "idle";
}

/**
 * The user's assistant avatar, centered and oversized as the takeover's focal
 * point. Falls back to a neutral bundled creature (and finally the "V") while
 * the avatar resolves or when none is configured. The idle breathe, the busy
 * body-morph and the reduced-motion gating all come from `AnimatedAvatar`
 * inside `ChatAvatar`.
 *
 * Nothing renders until the target assistant resolves and its avatar query
 * settles. `components ?? fallback`
 * synthesizes traits from the first bundled entry of each list — a green blob —
 * so drawing during the fetch shows a different assistant's avatar for a beat,
 * and the takeover is the one surface that reliably mounts cold: the Stripe
 * return is a full page load, so the fetch always loses the race. Withholding
 * costs no layout, because the stage reserves its height from first paint.
 *
 * On resolve it grows to `AVATAR_GROWTH` against a bottom baseline, so the
 * creature stands taller off its shadow instead of drifting up the screen. The
 * stage reserves the grown height from first paint. The strain loop sits on its
 * own nesting level so it composes with the growth rather than fighting it for
 * `transform`. The choreography lives in `.provision-avatar-*`.
 */
function TakeoverAvatar({
  assistantId,
  mode,
}: {
  assistantId?: string | null;
  mode: AvatarMode;
}) {
  // `useTakeoverSurface` owns which assistant the takeover draws and when its
  // avatar is safe to draw, so the creature and the paint around it can never
  // disagree about either.
  const { avatar, ready: avatarReady } = useTakeoverSurface(assistantId);
  const fallbackComponents = useBundledAvatarComponents();
  const size = useTakeoverAvatarSize();
  const laboring = mode === "working" || mode === "settling";
  // Every mode animates the wrapper or its child, so the class waits for
  // something to animate. Otherwise a phase that resolves before the fetch does
  // — likely here, since the avatar is read off the machine being restarted —
  // runs the grow on an empty wrapper and leaves the creature to fade in at its
  // final scale with the success beat already spent.
  const activeMode: AvatarMode = avatarReady ? mode : "idle";
  return (
    <div
      aria-hidden
      className={`provision-avatar-evolve relative z-10 flex flex-col items-center${AVATAR_MODE_CLASS[activeMode]}`}
      style={
        {
          "--provision-avatar-size": `${size}px`,
          "--provision-avatar-growth": AVATAR_GROWTH,
        } as CSSProperties
      }
    >
      <div className="provision-avatar-stage">
        <div className="provision-avatar-layer">
          <div className="provision-avatar-current">
            <div className="provision-avatar-strain">
              {avatarReady && (
                <div className="provision-avatar-reveal">
                  <ChatAvatar
                    components={avatar.components ?? fallbackComponents}
                    traits={avatar.traits}
                    customImageUrl={avatar.customImageUrl}
                    size={size}
                    isAssistantBusy={laboring}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="provision-avatar-shadow" />
    </div>
  );
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
  onPhaseChange,
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

  // The wizard locks itself against the phase on screen, not the live one.
  const onPhaseChangeRef = useRef(onPhaseChange);
  useEffect(() => {
    onPhaseChangeRef.current = onPhaseChange;
  }, [onPhaseChange]);
  useEffect(() => {
    onPhaseChangeRef.current?.(heldState);
  }, [heldState]);

  // The surface commits to a hue only once the avatar query settles, and eases
  // there over `--provision-reveal` — the same beat the avatar fades in on.
  const { tintHex, backdropImageUrl } = useTakeoverSurface(assistantId);

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
      className="provision-surface-settle relative flex h-full min-h-[420px] w-full flex-col items-center [justify-content:safe_center] gap-10 px-6 py-10 text-center"
      style={
        {
          [TAKEOVER_SURFACE_VAR]: tintHex,
          backgroundColor: TAKEOVER_SURFACE,
        } as CSSProperties
      }
    >
      {/* An absolutely positioned layer paints over in-flow siblings, so the
          content below carries `z-10` to sit on top of it. */}
      {backdropImageUrl && <TakeoverBackdrop imageUrl={backdropImageUrl} />}
      <TakeoverAvatar
        assistantId={assistantId}
        mode={avatarModeFor(heldState, softWaiting)}
      />
      {/* Keyed so each phase replays the entrance instead of swapping its copy
          in place. WAITING and RESIZING render identical copy, so they share a
          key and don't retrigger. The min-height anchors the block: phases
          carry different chip counts and captions, and without it the whole
          centred group jumps as they swap — most visibly under the resolve,
          where the shorter "All done!" copy would tug the evolving avatar up
          mid-animation. */}
      <div
        key={phaseKey}
        className="relative z-10 flex min-h-[144px] w-full flex-col items-center gap-8 [animation:onboarding-step-in_420ms_ease-out] motion-reduce:[animation:none]"
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
