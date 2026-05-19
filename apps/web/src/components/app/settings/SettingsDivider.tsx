
/**
 * Thin horizontal divider used inside Settings cards (e.g. to separate the
 * search row from the selected-value row in the timezone picker). Mirrors the
 * macOS `SettingsDivider` component.
 */
export function SettingsDivider({ className }: { className?: string }) {
  return (
    <div
      role="presentation"
      className={[
        "h-px w-full bg-[var(--border-base)]",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
