import { DetailCard } from "@/components/detail-card";
import {
  isProactiveTipsOn,
  useProactiveTipsVariant,
} from "@/hooks/use-proactive-tips-flag";
import { tipsEnabledStorage } from "@/utils/tips-storage";
import { Toggle } from "@vellumai/design-library/components/toggle";

export function ShowTipsCard() {
  const variant = useProactiveTipsVariant();
  const enabled = tipsEnabledStorage.useValue();

  if (!isProactiveTipsOn(variant)) {
    return null;
  }

  return (
    <DetailCard
      title="Tips"
      subtitle="Occasional tips in the sidebar that highlight features you haven't tried yet."
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-body-medium-lighter text-[var(--content-default)]">
          Show tips
        </div>
        <Toggle
          checked={enabled}
          onChange={tipsEnabledStorage.save}
          aria-label="Show tips"
        />
      </div>
    </DetailCard>
  );
}
