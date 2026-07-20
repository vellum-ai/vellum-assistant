import type { LucideIcon } from "lucide-react";
import { ArrowRight, Loader2 } from "lucide-react";

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
