/**
 * The About Assistant stage's peeking eyes: {@link PeekingEyes} driven by the
 * real assistant's avatar (components + traits props), sized against the stage
 * container rather than the viewport.
 */

import { useMemo } from "react";

import { PeekingEyes } from "@/components/avatar/peeking-eyes";
import type { StageSize } from "@/hooks/use-element-size";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";

interface AssistantPeekingEyesProps {
  components: CharacterComponents;
  traits: CharacterTraits;
  /** The stage container's box. The eyes anchor to its bottom edge. */
  stage: StageSize;
  /** Play the grow-in entrance. Otherwise the eyes are at rest. */
  entrance?: boolean;
  /** Delay before the entrance starts. */
  entranceDelay?: number;
}

export function AssistantPeekingEyes({
  components,
  traits,
  stage,
  entrance = false,
  entranceDelay = 0,
}: AssistantPeekingEyesProps) {
  const art = useMemo(() => {
    const def = components.eyeStyles.find((e) => e.id === traits.eyeStyle);
    if (!def) {
      return null;
    }
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, traits.eyeStyle]);

  if (!art) {
    return null;
  }

  return (
    <PeekingEyes
      art={art}
      stage={stage}
      entrance={entrance}
      entranceDelay={entranceDelay}
    />
  );
}
