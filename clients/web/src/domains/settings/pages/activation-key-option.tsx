import type { ReactNode } from "react";

export function ActivationKeyOption({
  label,
  badge,
  selected,
  recording = false,
  onClick,
}: {
  label: ReactNode;
  badge?: string;
  selected: boolean;
  recording?: boolean;
  onClick: () => void;
}) {
  const classes = [
    "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-body-medium-lighter transition-colors",
    "border-[var(--border-subtle)]",
    selected
      ? "bg-[var(--surface-active)]"
      : "bg-[var(--surface-lift)] hover:bg-[var(--surface-hover)]",
    recording ? "animate-pulse" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" onClick={onClick} className={classes}>
      <span
        className={[
          "inline-block h-2.5 w-2.5 rounded-full border",
          selected
            ? "border-[var(--primary-base)] bg-[var(--primary-base)]"
            : "border-[var(--border-element)]",
        ].join(" ")}
      />
      <span className="text-[var(--content-default)]">{label}</span>
      {badge && (
        <span className="text-body-small-default text-[var(--content-quiet)]">
          {badge}
        </span>
      )}
    </button>
  );
}
