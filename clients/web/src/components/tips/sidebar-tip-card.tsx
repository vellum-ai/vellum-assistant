/**
 * Connected proactive tip card — the single component the sidebar mounts.
 * `useTipCard` owns every gate and returns `tip: null` when nothing should
 * show, so this renders nothing until a tip is due.
 */

import { useTipCard } from "@/hooks/use-tip-card";

import { TipCard } from "./tip-card";

export function SidebarTipCard() {
  const { tip, onDismiss, onLearnMore, onDontShowAgain, onNextTip } =
    useTipCard();

  if (!tip) {
    return null;
  }

  return (
    <TipCard
      tip={tip}
      onDismiss={onDismiss}
      onLearnMore={onLearnMore}
      onDontShowAgain={onDontShowAgain}
      onNextTip={onNextTip}
    />
  );
}
