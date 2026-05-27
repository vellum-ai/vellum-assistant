
import { useMemo } from "react";

import { composeSvg } from "@/utils/avatar-svg-compositor";
import type { CharacterComponents } from "@/types/avatar";

export interface AvatarRendererProps {
  components: CharacterComponents;
  bodyShapeId: string;
  eyeStyleId: string;
  colorId: string;
  size?: number;
  className?: string;
}

export function AvatarRenderer({
  components,
  bodyShapeId,
  eyeStyleId,
  colorId,
  size = 56,
  className,
}: AvatarRendererProps) {
  const svgString = useMemo(() => {
    try {
      return composeSvg(components, bodyShapeId, eyeStyleId, colorId, size);
    } catch {
      return null;
    }
  }, [components, bodyShapeId, eyeStyleId, colorId, size]);

  if (!svgString) {
    return null;
  }

  return (
    <div
      className={className}
      style={{ width: size, height: size, flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: svgString }}
    />
  );
}
