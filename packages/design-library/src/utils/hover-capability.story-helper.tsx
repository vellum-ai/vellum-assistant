/**
 * Makes a story's subtree report that it cannot hover, which is what an iPad
 * or a phone reports and what the browser running the stories does not. The
 * surfaces that stand down there (tooltips above all) are otherwise only
 * reachable on a real device.
 *
 * A context override rather than a swapped `matchMedia`: the global is
 * sampled by every canvas mounted alongside on an autodocs page, so a swap
 * would make the ordinary stories misrepresent the browser they run in.
 */

import { type ReactNode } from "react";

import { HoverCapabilityOverride } from "./hover-capability";

export function WithoutHover({ children }: { children: ReactNode }) {
  return (
    <HoverCapabilityOverride hoverCapable={false}>
      {children}
    </HoverCapabilityOverride>
  );
}
