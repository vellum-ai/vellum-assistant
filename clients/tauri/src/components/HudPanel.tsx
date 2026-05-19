import type { JSX, ReactNode } from "react";

interface HudPanelProps {
  readonly title: string;
  readonly tag?: string;
  readonly tone?: "accent" | "warn" | "ok" | "danger" | "violet";
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly children: ReactNode;
}

/**
 * Generic HUD panel chrome. Provides a labelled header, animated corner
 * brackets, shimmer-on-load, and a faint live indicator dot. Reused by
 * every behind-the-scenes telemetry surface.
 */
export function HudPanel({
  title,
  tag,
  tone = "accent",
  className = "",
  bodyClassName = "",
  children,
}: HudPanelProps): JSX.Element {
  const toneClass =
    tone === "warn"
      ? "text-hud-warn"
      : tone === "ok"
        ? "text-hud-ok"
        : tone === "danger"
          ? "text-hud-danger"
          : tone === "violet"
            ? "text-[#9c8aff]"
            : "text-hud-accent";

  return (
    <div className={`hud-panel hud-panel-corners ${className}`}>
      <div className="hud-panel-title">
        <span className={toneClass}>{title}</span>
        <span className="ml-auto text-[8px] tracking-[0.4em] text-hud-mute">
          {tag ?? "LIVE"}
        </span>
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}
