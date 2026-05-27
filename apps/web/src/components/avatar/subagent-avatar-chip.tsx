/**
 * Inline-sized subagent avatar.
 *
 * Wraps the shared `AvatarRenderer` with the deterministic
 * `subagentTraits(subagentId)` mapping so callers can drop a small
 * (16px default) avatar inline — e.g. as the leading icon slot of a
 * subagent tool-call card, per Figma node `4922-103839`.
 *
 * Does not introduce a new bundle; reuses `BUNDLED_COMPONENTS` already
 * consumed by `SubagentInlineProgressCard`.
 */

import { AvatarRenderer } from "@/components/avatar-renderer";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { subagentTraits } from "@/utils/avatar-subagent";

export interface SubagentAvatarChipProps {
  subagentId: string;
  /** Pixel size for the rendered avatar. Defaults to 16 (inline size). */
  size?: number;
  className?: string;
}

export function SubagentAvatarChip({
  subagentId,
  size = 16,
  className,
}: SubagentAvatarChipProps) {
  const traits = subagentTraits(subagentId);

  // `AvatarRenderer` renders a `<div>` — wrapping it in a `<span>` produces
  // invalid HTML (block element inside an inline element) which browsers
  // may auto-correct by closing the span early, dropping our className and
  // aria-label. Use an inline-flex `<div>` instead so the wrapper still
  // composes inline visually but stays a valid block container.
  return (
    <div
      aria-label={`Subagent ${subagentId}`}
      className={`inline-flex ${className ?? ""}`.trim()}
    >
      <AvatarRenderer
        components={BUNDLED_COMPONENTS}
        bodyShapeId={traits.bodyShape}
        eyeStyleId={traits.eyeStyle}
        colorId={traits.color}
        size={size}
      />
    </div>
  );
}
