import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import { AvatarRenderer } from "@/components/avatar-renderer";
import { cn } from "@/utils/misc";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

import { extractOnboardingErrorMessage } from "./utils";

/** The manual Apply & Restart recovery threaded down from the modal. */
export interface StalledApplyAction {
  onApply: () => void;
  pending: boolean;
  error: unknown;
}

/** Warning shown when a backgrounded resize stalls mid-wizard. */
const STALLED_UPGRADE_WARNING =
  "We couldn't finish your machine upgrade automatically. Apply it now to finish — your assistant will briefly restart.";

/**
 * Warning notice + Apply & Restart button for recovering a stalled resize.
 * Shared by the complete screen and the domain step so the recovery affordance
 * can't drift between them. (The dark provisioning takeover renders its own
 * inline button by design.)
 */
export function StalledApplyControls({
  action,
  buttonTestId,
  className,
}: {
  action: StalledApplyAction;
  buttonTestId: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <Notice tone="warning" className="w-full text-left">
        {STALLED_UPGRADE_WARNING}
      </Notice>
      {action.error != null && (
        <Notice tone="error" className="w-full text-left">
          {extractOnboardingErrorMessage(
            action.error,
            "Couldn't apply changes. Please try again.",
          )}
        </Notice>
      )}
      <Button
        variant="outlined"
        data-testid={buttonTestId}
        disabled={action.pending}
        onClick={action.onApply}
      >
        Apply &amp; Restart
      </Button>
    </div>
  );
}

export function IconBadge({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      className="flex h-11 w-11 items-center justify-center rounded-full"
      style={{
        backgroundColor:
          "color-mix(in oklab, var(--system-negative-strong) 12%, transparent)",
      }}
    >
      <Icon
        className="h-5 w-5"
        style={{ color: "var(--system-negative-strong)" }}
        aria-hidden="true"
      />
    </span>
  );
}

/**
 * Shared serif heading style (Instrument Serif via `--font-serif`) for the pro
 * onboarding cards and the provisioning takeover, so the two can't drift.
 */
export const SERIF_HEADING_STYLE: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontSize: "32px",
  fontWeight: 400,
  lineHeight: 1.2,
  letterSpacing: "0.64px",
};

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
      <h2 className="text-[var(--content-emphasised)]" style={SERIF_HEADING_STYLE}>
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

/**
 * Drops `Notice`'s outline for the tinted fill the onboarding mocks draw. Pair
 * it with `tone="info"`, which supplies the leading icon.
 */
export const SUBTLE_NOTICE_CLASS =
  "border-transparent bg-[var(--surface-active)]";

/**
 * Goes on a span wrapping the notice copy — `Notice` pipes children through its
 * own `Typography`, so the mock's weight and tone have to be set on a child.
 */
export const SUBTLE_NOTICE_TEXT_CLASS =
  "font-medium text-[var(--content-tertiary)]";

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
 * Deterministic creature scatter for the all-set card (`variant="full"`): six
 * creatures scattered around every edge. Sizes and edge overhangs are the
 * mock's values scaled by 1.167, since the card renders 560px wide against
 * the 480px mock frame; horizontal centers stay proportional.
 */
const CREATURE_PLACEMENTS: CreaturePlacement[] = [
  { bodyShape: "star", eyeStyle: "curious", color: "yellow", size: 103, position: "-left-[28px] -top-[33px]", rotate: 180 },
  { bodyShape: "star", eyeStyle: "curious", color: "orange", size: 109, position: "left-[63%] -top-[62px] -translate-x-1/2", rotate: -8 },
  { bodyShape: "blob", eyeStyle: "grumpy", color: "green", size: 76, position: "-right-[25px] top-[60px]", rotate: 1 },
  { bodyShape: "stack", eyeStyle: "gentle", color: "purple", size: 110, position: "-left-[39px] top-[74%]", rotate: 0 },
  { bodyShape: "urchin", eyeStyle: "goofy", color: "pink", size: 137, position: "-right-[42px] -bottom-[40px]", rotate: 180 },
  { bodyShape: "sprout", eyeStyle: "curious", color: "orange", size: 72, position: "left-[37%] -bottom-[22px] -translate-x-1/2", rotate: 0 },
];

/**
 * Deterministic creature scatter for the email card (`variant="top"`): three
 * creatures tuned to the email-step mock — a rotated yellow star hanging off
 * the top-left corner, an orange star upper-center-right, and a heavy-lidded
 * green blob peeking in from the right edge.
 */
const TOP_CREATURE_PLACEMENTS: CreaturePlacement[] = [
  { bodyShape: "star", eyeStyle: "curious", color: "yellow", size: 103, position: "-left-[28px] -top-[33px]", rotate: 180 },
  { bodyShape: "star", eyeStyle: "curious", color: "orange", size: 109, position: "left-[63%] -top-[62px] -translate-x-1/2", rotate: -8 },
  { bodyShape: "blob", eyeStyle: "grumpy", color: "green", size: 76, position: "-right-[25px] top-[60px]", rotate: 1 },
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
    variant === "top" ? TOP_CREATURE_PLACEMENTS : CREATURE_PLACEMENTS;

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
