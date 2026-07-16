/**
 * Interception wrapper for a gated sidenav region.
 *
 * Wraps a region of the side menu (an item, the header action, the
 * conversations section, the preferences footer) and — while the region is
 * gated — swallows interactions at the capture phase and opens the avatar
 * bubble instead. Capture-phase interception is deliberate: it needs no
 * rewiring of the wrapped components' handlers, and it catches Radix menu
 * triggers, which open on pointerdown rather than click.
 *
 * The third click on the same region quietly unlocks it: the event is let
 * through untouched so the original action runs on that very click.
 */

import { useRef, type PointerEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "@vellumai/design-library";

import {
  isNavItemGated,
  useNavGateStore,
  type NavGateItemId,
} from "@/domains/chat/nav-gate/nav-gate-store";
import {
  emitDisabledItemClick,
  emitQuietUnlock,
} from "@/domains/chat/nav-gate/nav-gate-telemetry";
import { useNavGateArm } from "@/domains/chat/nav-gate/use-nav-gate";

export function NavGateRegion({
  item,
  className,
  children,
}: {
  item: NavGateItemId;
  className?: string;
  children: ReactNode;
}) {
  const arm = useNavGateArm();
  const sentCount = useNavGateStore.use.sentCount();
  const attempts = useNavGateStore.use.attempts();
  const gated = isNavItemGated(arm, item, { sentCount, attempts });

  const regionRef = useRef<HTMLDivElement | null>(null);
  // Pointer flow per click is pointerdown → click. When pointerdown is
  // swallowed, the browser still dispatches the click; when the third click
  // unlocks, the re-render to an ungated region may lag the click event.
  // Both flags bridge exactly one pointerdown to its click.
  const suppressNextClickRef = useRef(false);
  const passNextClickRef = useRef(false);

  const registerClick = (): "bubble" | "unlock" => {
    const attempt = (useNavGateStore.getState().attempts[item] ?? 0) + 1;
    const outcome = useNavGateStore
      .getState()
      .registerGatedClick(item, regionRef.current);
    emitDisabledItemClick(arm, item, attempt);
    if (outcome === "unlock") {
      emitQuietUnlock(arm, item);
    }
    return outcome;
  };

  // Regions can nest (the new-conversation action lives inside the history
  // section); the innermost region containing the event target owns it, so
  // an outer region must defer rather than swallow the inner one's clicks.
  const ownsEvent = (event: PointerEvent | MouseEvent): boolean => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return true;
    }
    return target.closest("[data-nav-gate-region]") === regionRef.current;
  };

  const handlePointerDownCapture = (event: PointerEvent) => {
    if (!gated || passNextClickRef.current || !ownsEvent(event)) {
      return;
    }
    if (registerClick() === "unlock") {
      passNextClickRef.current = true;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressNextClickRef.current = true;
  };

  const handleClickCapture = (event: MouseEvent) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (passNextClickRef.current) {
      passNextClickRef.current = false;
      return;
    }
    if (!gated || !ownsEvent(event)) {
      return;
    }
    // Keyboard activation (Enter/Space) arrives as a click with no preceding
    // pointerdown.
    if (registerClick() !== "unlock") {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      ref={regionRef}
      data-nav-gate-region={item}
      data-nav-gated={gated || undefined}
      onPointerDownCapture={handlePointerDownCapture}
      onClickCapture={handleClickCapture}
      className={cn(
        gated && "opacity-60 transition-opacity duration-300",
        className,
      )}
    >
      {children}
    </div>
  );
}
