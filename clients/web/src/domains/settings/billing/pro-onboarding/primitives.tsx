import type { LucideIcon } from "lucide-react";
import { ArrowRight, Loader2 } from "lucide-react";

import type { ButtonVariant } from "@vellumai/design-library/components/button";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import { AvatarRenderer } from "@/components/avatar-renderer";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import { extractOnboardingErrorMessage } from "./utils";

/** The manual Apply & Restart recovery threaded down from the modal. */
export interface StalledApplyAction {
  onApply: () => void;
  pending: boolean;
  error: unknown;
}

/** Warning shown when a backgrounded resize stalls mid-wizard. */
export const STALLED_UPGRADE_WARNING =
  "We couldn't finish your machine upgrade automatically. Apply it now to finish — your assistant will briefly restart.";

/**
 * Error notice + Apply & Restart button for recovering a stalled resize.
 * Shared by the provisioning screen, the complete screen, and the domain
 * step so the recovery affordance can't drift between them.
 */
export function StalledApplyControls({
  action,
  buttonVariant = "primary",
  buttonTestId,
}: {
  action: StalledApplyAction;
  buttonVariant?: ButtonVariant;
  buttonTestId: string;
}) {
  return (
    <>
      {action.error != null && (
        <Notice tone="error" className="w-full text-left">
          {extractOnboardingErrorMessage(
            action.error,
            "Couldn't apply changes. Please try again.",
          )}
        </Notice>
      )}
      <Button
        variant={buttonVariant}
        data-testid={buttonTestId}
        disabled={action.pending}
        onClick={action.onApply}
      >
        Apply &amp; Restart
      </Button>
    </>
  );
}

export function IconBadge({
  icon: Icon,
  tone = "positive",
}: {
  icon: LucideIcon;
  tone?: "positive" | "negative" | "warning";
}) {
  const toneVar =
    tone === "positive"
      ? "--system-positive-strong"
      : tone === "warning"
        ? "--system-mid-strong"
        : "--system-negative-strong";
  return (
    <span
      className="flex h-11 w-11 items-center justify-center rounded-full"
      style={{
        backgroundColor: `color-mix(in oklab, var(${toneVar}) 12%, transparent)`,
      }}
    >
      <Icon
        className="h-5 w-5"
        style={{ color: `var(${toneVar})` }}
        aria-hidden="true"
      />
    </span>
  );
}

export function GlowSpinner() {
  return (
    <div className="relative flex h-11 w-11 items-center justify-center">
      <div
        className="absolute h-14 w-14 animate-[onboarding-glow_2.4s_ease-in-out_infinite] rounded-full motion-reduce:animate-none"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--system-positive-strong) 10%, transparent)",
        }}
        aria-hidden="true"
      />
      <div
        className="absolute h-9 w-9 animate-[onboarding-glow_2.4s_ease-in-out_infinite_0.4s] rounded-full motion-reduce:animate-none"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--system-positive-strong) 8%, transparent)",
        }}
        aria-hidden="true"
      />
      <Loader2
        className="relative h-5 w-5 animate-spin text-[var(--system-positive-strong)]"
        aria-hidden="true"
      />
    </div>
  );
}

export function ResourceCard({
  icon: Icon,
  label,
  from,
  fromDetail,
  to,
  toDetail,
}: {
  icon: LucideIcon;
  label: string;
  from: string;
  fromDetail?: string;
  to: string;
  toDetail?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-[var(--surface-base)] p-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{
          backgroundColor: "color-mix(in oklab, var(--system-positive-strong) 10%, transparent)",
        }}
      >
        <Icon className="h-4 w-4 text-[var(--system-positive-strong)]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-label-small-default text-[var(--content-tertiary)]">
          {label}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex flex-col">
            <span className="text-label-medium-default text-[var(--content-tertiary)] line-through">
              {from}
            </span>
            {fromDetail && (
              <span className="text-label-small-default text-[var(--content-tertiary)] line-through">
                {fromDetail}
              </span>
            )}
          </div>
          <ArrowRight className="h-3 w-3 shrink-0 text-[var(--content-tertiary)]" />
          <div className="flex flex-col">
            <span className="text-label-medium-default text-[var(--content-default)]">
              {to}
            </span>
            {toDetail && (
              <span className="text-label-small-default text-[var(--content-tertiary)]">
                {toDetail}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Centered serif card heading (Instrument Serif via `--font-serif`) with an
 * optional supporting subtitle, matching the takeover-header treatment used
 * on the plans page. Pure presentation.
 */
export function WizardCardHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="flex flex-col items-center gap-2 pt-12 text-center">
      <h2
        className="text-[var(--content-emphasised)]"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: "32px",
          fontWeight: 400,
          lineHeight: 1.2,
          letterSpacing: "0.64px",
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <p className="text-[14px] font-normal text-[var(--content-secondary)]">
          {subtitle}
        </p>
      )}
    </header>
  );
}

/** A single decorative creature: fixed traits + placement, no randomness. */
interface CreaturePlacement {
  bodyShape: string;
  eyeStyle: string;
  color: string;
  size: number;
  /** Absolute-position offset classes; negative offsets clip at the card edge. */
  position: string;
  /** Static rotation (deg); no animation, so reduced-motion is a no-op here. */
  rotate: number;
}

/**
 * Deterministic creature scatter per variant. Ordered top-edge first so the
 * `"top"` variant is simply the first three of the `"full"` set.
 */
const CREATURE_PLACEMENTS: CreaturePlacement[] = [
  { bodyShape: "blob", eyeStyle: "goofy", color: "green", size: 56, position: "-left-4 -top-6", rotate: -12 },
  { bodyShape: "sprout", eyeStyle: "curious", color: "orange", size: 48, position: "left-1/2 -top-8 -translate-x-1/2", rotate: 6 },
  { bodyShape: "urchin", eyeStyle: "surprised", color: "teal", size: 56, position: "-right-4 -top-6", rotate: 14 },
  { bodyShape: "star", eyeStyle: "gentle", color: "purple", size: 44, position: "-left-6 top-1/2 -translate-y-1/2", rotate: -20 },
  { bodyShape: "ghost", eyeStyle: "bashful", color: "pink", size: 44, position: "-right-6 top-1/2 -translate-y-1/2", rotate: 18 },
  { bodyShape: "flower", eyeStyle: "quirky", color: "yellow", size: 52, position: "left-1/2 -bottom-8 -translate-x-1/2", rotate: -8 },
];

/**
 * Absolutely-positioned decoration layer that scatters bundled Vellum
 * creatures around a card's edges (clipped by the card's `overflow-hidden`).
 * `variant="top"` places three across the top edge (email card); `variant="full"`
 * scatters six around all edges (all-set card). Renders nothing until the lazy
 * avatar-components chunk resolves. Decorative only — `aria-hidden`.
 */
export function CreatureCorners({
  variant = "full",
}: {
  variant?: "top" | "full";
}) {
  const components = useBundledAvatarComponents();
  if (!components) {
    return null;
  }

  const placements =
    variant === "top" ? CREATURE_PLACEMENTS.slice(0, 3) : CREATURE_PLACEMENTS;

  return (
    <div
      aria-hidden="true"
      data-testid="creature-corners"
      className="pointer-events-none absolute inset-0 select-none"
    >
      {placements.map((creature, index) => (
        <span
          key={index}
          className={`absolute ${creature.position}`}
          style={{ rotate: `${creature.rotate}deg` }}
        >
          <AvatarRenderer
            components={components}
            bodyShapeId={creature.bodyShape}
            eyeStyleId={creature.eyeStyle}
            colorId={creature.color}
            size={creature.size}
          />
        </span>
      ))}
    </div>
  );
}
