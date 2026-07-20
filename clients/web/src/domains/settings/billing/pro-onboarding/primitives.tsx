import type { LucideIcon } from "lucide-react";
import { ArrowRight, Loader2 } from "lucide-react";

import type { ButtonVariant } from "@vellumai/design-library/components/button";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

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
