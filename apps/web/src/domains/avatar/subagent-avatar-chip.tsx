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

import { AvatarRenderer } from "@/components/avatar-renderer.js";
import { BUNDLED_COMPONENTS } from "@/domains/avatar/bundled-components.js";
import { subagentTraits } from "@/domains/avatar/subagent-avatar.js";

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

  return (
    <span aria-label={`Subagent ${subagentId}`} className={className}>
      <AvatarRenderer
        components={BUNDLED_COMPONENTS}
        bodyShapeId={traits.bodyShape}
        eyeStyleId={traits.eyeStyle}
        colorId={traits.color}
        size={size}
      />
    </span>
  );
}
