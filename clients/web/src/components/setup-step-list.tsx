import { type ReactNode } from "react";

export interface SetupStepListProps {
  /** One `<li>` per action the user performs, in order. */
  children: ReactNode;
}

/**
 * The ordered list of portal actions a setup step walks someone through.
 *
 * Every channel's create step draws the same list, and the styling is a long
 * class string that was copied between them. One component so a fourth
 * channel inherits the list rather than re-deriving it.
 */
export function SetupStepList({ children }: SetupStepListProps) {
  return (
    <ol className="list-decimal list-outside space-y-1 pl-5 text-body-medium-lighter text-[var(--content-default)]">
      {children}
    </ol>
  );
}
