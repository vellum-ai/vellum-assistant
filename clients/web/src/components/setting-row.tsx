import { useId } from "react";

import { Toggle } from "@vellumai/design-library/components/toggle";

type SettingRowVariant = "toggle-leading" | "toggle-trailing";

/**
 * A labelled toggle row ("label + helper text + switch") shared across the
 * onboarding and settings surfaces.
 *
 * `variant` controls toggle placement:
 * - `toggle-leading` (default) — switch before the label; used by the
 *   onboarding privacy and review-terms screens.
 * - `toggle-trailing` — label on the left, switch pushed to the far end; used
 *   by the settings Privacy page.
 *
 * Both variants associate the label with the switch via `htmlFor`, so the
 * label text is clickable and screen-reader-associated.
 */
export function SettingRow({
  label,
  helperText,
  checked,
  onChange,
  variant = "toggle-leading",
}: {
  label: string;
  helperText: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  variant?: SettingRowVariant;
}) {
  const toggleId = useId();
  const toggle = <Toggle checked={checked} onChange={onChange} id={toggleId} />;
  const text = (
    <label htmlFor={toggleId} className="min-w-0 flex-1 cursor-pointer">
      <span className="block text-body-medium-default text-[var(--content-default)]">
        {label}
      </span>
      <span className="mt-1 block text-body-small-default text-[var(--content-tertiary)]">
        {helperText}
      </span>
    </label>
  );

  if (variant === "toggle-trailing") {
    return (
      <div className="flex items-start justify-between gap-4">
        {text}
        {toggle}
      </div>
    );
  }

  return (
    <div className="flex items-start gap-4">
      {toggle}
      {text}
    </div>
  );
}
