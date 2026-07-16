import { DetailCard } from "@/components/detail-card";
import {
  isProactiveTipsOn,
  useProactiveTipsVariant,
} from "@/hooks/use-proactive-tips-flag";
import { tipsEnabledStorage } from "@/utils/tips-storage";
import { emitTipEvent } from "@/utils/tips-telemetry";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function ShowTipsCard() {
  const variant = useProactiveTipsVariant();
  const enabled = tipsEnabledStorage.useValue();

  if (!isProactiveTipsOn(variant)) {
    return null;
  }

  const onToggle = (next: boolean) => {
    tipsEnabledStorage.save(next);
    // The global opt-out signal: the card itself has no don't-show-again
    // affordance, so this toggle is the only place it can be observed.
    if (!next) {
      emitTipEvent("settings", "dont_show_again", variant);
    }
  };

  return (
    <DetailCard
      title="Tips"
      subtitle="Occasional tips in the sidebar that highlight features you haven't tried yet."
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-body-medium-lighter text-[var(--content-default)]">
          Show tips
        </div>
        <Toggle checked={enabled} onChange={onToggle} aria-label="Show tips" />
      </div>
    </DetailCard>
  );
}
