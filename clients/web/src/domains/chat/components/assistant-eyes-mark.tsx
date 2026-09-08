/**
 * The assistant's eyes, as a standalone mark.
 *
 * The eye sprite is derived the same way in several places already (the
 * assistant nav row, the onboarding tour's narration and nav flood): find the
 * avatar's eye style, union its paths into a viewBox, size it by the per-style
 * hand-tuned width. This packages that derivation so a fourth caller does not
 * have to repeat it. The existing three predate it and are left alone rather
 * than refactored under an unrelated change.
 *
 * Static: no blink, no pulse. The nav row's eyes live inside a loop that also
 * drives the collapsed rail's growth, and those behaviours belong to that row,
 * not to the mark itself.
 *
 * Renders `null` when the assistant has no character avatar (a custom image, or
 * still loading), so callers can drop it in without guarding.
 */

import { useMemo } from "react";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { eyeStyleBaseWidth } from "@/utils/assistant-eyes";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

export function AssistantEyesMark({
  assistantId,
  /**
   * Overrides the per-style natural width. Height always follows the sprite's
   * own aspect ratio, so the eyes never distort.
   */
  width,
  className,
}: {
  assistantId: string | null;
  width?: number;
  className?: string;
}) {
  const { components, traits } = useAssistantAvatar(assistantId);

  const eye = useMemo(() => {
    if (!components || !traits) {
      return null;
    }
    const def = components.eyeStyles.find((e) => e.id === traits.eyeStyle);
    if (!def) {
      return null;
    }
    return {
      id: def.id,
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, traits]);

  if (!eye) {
    return null;
  }

  const w = width ?? eyeStyleBaseWidth(eye.id);
  const h = w * (eye.bbox.h / eye.bbox.w);

  return (
    <svg
      aria-hidden
      className={className}
      viewBox={`${eye.bbox.x} ${eye.bbox.y} ${eye.bbox.w} ${eye.bbox.h}`}
      width={w}
      height={h}
      preserveAspectRatio="xMidYMid meet"
      style={{ overflow: "visible", display: "block" }}
    >
      {eye.paths.map((p, i) => (
        <path key={i} d={p.svgPath} fill={p.color} />
      ))}
    </svg>
  );
}
