import type { ReactNode } from "react";

/**
 * Two-panel layout for Beats 3–6: the option set on the left (the user acting),
 * the live conversation on the right (the assistant working). One cohesive dark
 * surface — the left keeps the cave/spotlight feel, the right is a calmer
 * workspace divided by a hairline.
 */
export function CastTwoPanel({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="cast-twopanel">
      <div className="cast-twopanel__left">{left}</div>
      <div className="cast-twopanel__right">{right}</div>
    </div>
  );
}
