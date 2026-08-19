import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Check,
  Coins,
  Cpu,
  HardDrive,
  Loader2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { formatMonthly } from "@/domains/settings/components/tier-pricing";
import type { MachineSizeEnum } from "@/generated/api/types.gen";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import { MACHINE_TIER_LABEL } from "@/lib/billing/machine-sizes";
import type { ProvisioningDimensionFlags } from "@/lib/billing/provisioning-targets";
import { useTranslation } from "@/i18n";
import { SURFACE_GROUND } from "@/utils/avatar-tone";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import type {
  ProvisioningDimensions,
  ProvisioningStateKind,
} from "./provisioning-machine";
import { SERIF_HEADING_STYLE } from "./primitives";
import {
  buildResourceChanges,
  type ResourceChangeKey,
} from "./resource-changes";
import { TakeoverBackdrop } from "./takeover-backdrop";
import { takeoverCopy, type TakeoverDirection } from "./takeover-copy";
import {
  useProvisioningCredits,
  useResizeCreditsChange,
  type CreditTierChange,
} from "./use-provisioning-credits";
import { useTakeoverSurface } from "./use-takeover-surface";
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

// The takeover avatar's resting size, and how much bigger it stands once the
// upgrade lands — the mock's 244px → 346px pair. Growth is a transform, so the
// SVG scales without re-rendering at a second size.
const AVATAR_SIZE = 240;
const AVATAR_GROWTH = 1.414;

// The stage reserves the grown height from first paint, so the takeover needs
// `size * AVATAR_GROWTH + 309` of viewport before the phase block underneath —
// which carries the escape hatch — starts to clip. Step the creature down
// instead of pushing that control off a short screen.
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
  /** Which way the change goes; selects the phase copy. */
  direction?: TakeoverDirection;
  /** Softens the waiting sub-copy once the grace period has elapsed. */
  softWaiting: boolean;
  /** The checkout selection stashed before the Stripe redirect. */
  intent: CheckoutIntent | null;
  /**
   * Resize mode only: the credit tiers an in-place change moves between,
   * captured by the plans page before the change landed. `null` or `undefined`
   * means the change left the bundle alone and the credits chip is dropped.
   * Distinct from `intent` on purpose: resize mode never reads the checkout
   * intent, so a stale one can't leak in here.
   */
  creditsChange?: CreditTierChange | null;
  targets: ProvisioningDimensions;
  /** Pre-resize actuals rendered as the "from" side of the resource chips. */
  fromSnapshot: ProvisioningDimensions;
  /**
   * Machine size a package with no machine tier settles at, so the resulting
   * downsize still gets a chip. Display only; it never feeds the targets.
   */
  machineFloor?: MachineSizeEnum | null;
  /**
   * Per-dimension provisioning progress. A dimension that has landed shows the
   * green check on its chip; the rest spin. Omitted, every dimension chip stays
   * pending until the phase itself resolves.
   */
  landed?: ProvisioningDimensionFlags;
  celebrating: boolean;
  onCelebrationEnd: () => void;
  /** The assistant being provisioned — drives the takeover avatar. */
  assistantId?: string | null;
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
 * Nothing renders until something is drawable: the live query settling, or the
 * stash captured at the Stripe hand-off. `components ?? fallback`
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
  downsizing = false,
}: {
  assistantId?: string | null;
  mode: AvatarMode;
  /**
   * Run the resolve in reverse: start at the grown size and settle into the
   * resting one. A plan that steps down should not end on a creature standing
   * taller than it started, which reads as the opposite of what happened.
   */
  downsizing?: boolean;
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
      className={`provision-avatar-evolve relative z-10 flex flex-col items-center${AVATAR_MODE_CLASS[activeMode]}${downsizing ? " is-downsizing" : ""}`}
      style={
        {
          "--provision-avatar-size": `${size}px`,
          "--provision-avatar-growth": AVATAR_GROWTH,
        } as CSSProperties
      }
    >
      <div className="provision-avatar-stage">
        {/* Always rendered, and first, so the creature reveals over it. */}
        <div
          data-testid="provision-avatar-placeholder"
          className={`provision-avatar-placeholder${avatarReady ? " is-resolved" : ""}`}
        />
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

/**
 * One resource dimension as a `{current} -> {new}` chip. `done` marks it
 * arrived with a green check, `pending` dims it and spins in the same trailing
 * slot; the two are mutually exclusive.
 *
 * The chip is built to shrink: `min-w-0` on the outer box and on the text
 * column releases the flex minimum content size, the value row wraps between
 * its parts, and `wrap-anywhere` lets a single unbreakable word ("Machine",
 * "credits/mo") break rather than spill into the chip beside it. `anywhere`
 * rather than `break-word` because only `anywhere` feeds the break opportunity
 * into min-content sizing, which is what a shrinking flex item measures itself
 * against. Together those bound the chip at every width, so the row it sits in
 * never needs a second line.
 *
 * Below 420px there is no width to spare for the decorative icon, so it drops
 * out and hands its 32px to the text.
 *
 * The check and the spinner are both `aria-hidden` and the dimming is pure
 * paint, so an `sr-only` status carries the per-dimension progress, and an
 * `sr-only` "to" carries the relation the arrow glyph draws.
 */
function DimensionChip({
  icon: Icon,
  label,
  from,
  to,
  done = false,
  pending = false,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  from?: string;
  to: string;
  done?: boolean;
  pending?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation("settings");
  let status: string | null = null;
  if (done) {
    status = t("provisioningState.statusComplete");
  } else if (pending) {
    status = t("provisioningState.statusPending");
  }
  return (
    <div
      data-testid={testId}
      // `flex-auto`, not `flex-1`: chips size from their own content and then
      // share what is left over. Equal thirds would wrap the widest value while
      // its neighbour sat on slack, which is what a rate pair does next to a
      // machine size. `min-w-0` keeps the shrink chain for narrow viewports.
      className={`flex min-w-0 flex-auto items-center gap-2 rounded-lg px-2 py-1.5${
        pending ? " opacity-70" : ""
      }`}
      style={{ backgroundColor: CHIP_BACKGROUND }}
    >
      <span className="hidden h-6 w-6 shrink-0 items-center justify-center min-[420px]:flex">
        <Icon
          className="h-3.5 w-3.5 text-[var(--content-tertiary)]"
          aria-hidden="true"
        />
      </span>
      <div className="flex min-w-0 flex-col gap-1 text-left wrap-anywhere">
        <span className="text-[12px] font-medium leading-tight text-[var(--content-tertiary)]">
          {label}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[14px] font-medium leading-[18px] text-[var(--content-emphasised)]">
          {from && (
            <>
              <span>{from}</span>
              <span className="sr-only">{t("provisioningState.srOnlyTo")}</span>
              <ArrowRight
                className="h-3 w-3 shrink-0 text-[var(--content-tertiary)]"
                aria-hidden="true"
              />
            </>
          )}
          {/* The destination and its progress mark travel as one item. The row
           * wraps so a long value can break instead of clipping the chip, and
           * without this the mark is what wraps: it is the last and smallest
           * thing on the line, so it lands alone underneath and reads as
           * belonging to nothing. */}
          <span className="inline-flex items-center gap-1.5">
            <span>{to}</span>
            {done ? (
              <Check
                data-testid="chip-check"
                className="h-3.5 w-3.5 shrink-0 text-[var(--system-positive-strong)]"
                aria-hidden="true"
              />
            ) : (
              pending && (
                <Loader2
                  data-testid="chip-spinner"
                  className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--content-tertiary)] motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )
            )}
          </span>
          {status && <span className="sr-only">{status}</span>}
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

/**
 * The chips occupy a single row at every viewport width. `max-w-sm` is the
 * mock's cap and holds two chips; a third needs `wide`, because three chips at
 * the value type's single-line width run to roughly 583px and `max-w-sm` (384px)
 * clips them. Below the cap `w-full` binds and the chips shrink instead, taking
 * a second line inside themselves, then breaking their own words once even that
 * runs out, rather than wrapping the row.
 *
 * `items-stretch` keeps the chips equal height when one takes that second line.
 */
function ChipRow({
  children,
  wide = false,
  testId,
}: {
  children: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex w-full ${wide ? "max-w-2xl" : "max-w-sm"} items-stretch justify-center gap-2`}
    >
      {children}
    </div>
  );
}

/**
 * Whether a chip has arrived. Credits apply the moment the plan change is
 * accepted, with nothing to roll out, so their chip is landed from first paint;
 * machine and storage each report their own progress.
 */
function chipDone(
  key: ResourceChangeKey,
  landed: ProvisioningDimensionFlags | undefined,
): boolean {
  if (key === "credits") {
    return true;
  }
  return landed?.[key] === true;
}

/**
 * The takeover's resource chips: every applicable change as a `{current} ->
 * {new}` chip (machine and storage from `targets`, `fromSnapshot` and the
 * display-only `machineFloor`; credits as a from-to monthly rate, `$0/mo` on
 * the from-side for a base-to-pro checkout).
 *
 * All of them render together from the first paint of the wait, each carrying
 * its own progress: dimmed with a spinner while its dimension is still moving,
 * green check once it arrives. Showing them one at a time would hide the resize
 * the user is actually waiting on behind a dimension that was never in doubt.
 *
 * Each chip states its progress in `sr-only` text, which is what a user gets by
 * navigating the row at any point in the wait. Discoverable text alone is
 * silent on change, so the row also carries a polite live region naming the
 * dimensions that read complete. It names them rather than announcing a bare
 * status word, which on its own says nothing about which dimension arrived, and
 * it holds whatever already reads complete at first paint as its baseline so
 * credits (complete from the start) never announces.
 *
 * `allDone` is the terminal phase, where the state itself is the signal for
 * every dimension. The from-to arrow survives it, so one chip format covers
 * every phase the row appears in.
 *
 * `creditsOnly` narrows the row to the credit move, for a phase that owes no
 * machine or storage work at all.
 */
function ResourceChangeChips({
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
    credits:
      credits != null
        ? {
            from: formatMonthly(credits.fromUsd * 100),
            to: formatMonthly(credits.toUsd * 100),
          }
        : null,
  });
  const changes = creditsOnly
    ? built.filter((change) => change.key === "credits")
    : built;

  const completed = changes
    .filter((change) => allDone || chipDone(change.key, landed))
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

  return (
    <>
      <ChipRow testId="resource-chips" wide={changes.length >= 3}>
        {changes.map((change) => {
          const done = allDone || chipDone(change.key, landed);
          return (
            <DimensionChip
              key={change.key}
              testId={`chip-${change.key}`}
              icon={RESOURCE_CHIP_ICON[change.key]}
              label={change.label}
              from={change.from}
              to={change.to}
              done={done}
              pending={!done}
            />
          );
        })}
      </ChipRow>
      <p aria-live="polite" className="sr-only" data-testid="chip-announcement">
        {announcement}
      </p>
    </>
  );
}

/** CONFIRMING chips: derived from the stashed intent before any API data lands. */
function IntentChips({ intent }: { intent: CheckoutIntent }) {
  const { t } = useTranslation("settings");
  if (intent.kind === "package") {
    const name =
      intent.packageKey.charAt(0).toUpperCase() + intent.packageKey.slice(1);
    return (
      <ChipRow>
        <TextChip
          label={t("provisioningState.packageChip", { name })}
        />
      </ChipRow>
    );
  }
  // A custom intent can carry all three items, which needs the same wider cap
  // the resource row uses for three chips.
  const itemCount = [
    intent.machineTier,
    intent.storageTier,
    intent.creditTier,
  ].filter((tier) => tier != null).length;
  return (
    <ChipRow wide={itemCount >= 3}>
      {intent.machineTier != null && (
        <DimensionChip
          icon={Cpu}
          label={t("provisioningState.machineLabel")}
          to={MACHINE_TIER_LABEL[intent.machineTier] ?? intent.machineTier}
        />
      )}
      {intent.storageTier != null && (
        <DimensionChip
          icon={HardDrive}
          label={t("provisioningState.storageLabel")}
          to={intent.storageTier.toUpperCase()}
        />
      )}
      {intent.creditTier != null && (
        <TextChip
          label={t("provisioningState.creditsChip", {
            count: intent.creditTier.replace("credits_", ""),
          })}
        />
      )}
    </ChipRow>
  );
}

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
  assistantId,
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
        // Only a known step down inverts the motion. A move whose direction
        // nobody knows must not claim one, so it keeps the resolve it has.
        downsizing={direction === "downgrade"}
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

  /** The resource row; `allDone` is the terminal phase forcing every check on. */
  function resourceChips({
    allDone = false,
    creditsOnly = false,
  }: { allDone?: boolean; creditsOnly?: boolean } = {}) {
    return (
      <ResourceChangeChips
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
          {intent && <IntentChips intent={intent} />}
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
          {resourceChips()}
          {escapeButton()}
        </>
      );
    }

    if (heldState === "DONE") {
      return (
        <>
          <Copy status={t("provisioningState.allDoneStatus")} />
          {resourceChips({ allDone: true })}
        </>
      );
    }

    if (heldState === "NOT_APPLICABLE") {
      // Terminal for a change that owes no provisioning, a credit-only switch
      // above all, so the credit move is its one statement of what changed. No
      // machine or storage work is outstanding here by construction, so a
      // resource chip could only report a dimension that stayed put.
      return (
        <>
          <Copy status={t("provisioningState.planReadyStatus")} />
          {resourceChips({ allDone: true, creditsOnly: true })}
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
              snag
                ? copy.snagStatus
                : t("provisioningState.takingLongerStatus")
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
          {resourceChips()}
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
