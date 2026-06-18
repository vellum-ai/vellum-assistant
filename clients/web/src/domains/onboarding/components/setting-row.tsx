import { useId } from "react";

import { Toggle } from "@vellumai/design-library/components/toggle";

export function SettingRow({
  label,
  helperText,
  checked,
  onChange,
}: {
  label: string;
  helperText: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const toggleId = useId();
  return (
    <div className="flex items-start gap-4">
      <Toggle checked={checked} onChange={onChange} id={toggleId} />
      <label htmlFor={toggleId} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-body-medium-default text-[var(--content-default)]">
          {label}
        </span>
        <span className="mt-1 block text-body-small-default text-[var(--content-tertiary)]">
          {helperText}
        </span>
      </label>
    </div>
  );
}
