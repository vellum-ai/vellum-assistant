import {
  isProactiveTipsOn,
  useProactiveTipsVariant,
} from "@/hooks/use-proactive-tips-flag";
import { tipsEnabledStorage } from "@/utils/tips-storage";
import { emitTipEvent } from "@/utils/tips-telemetry";
import { Toggle } from "@vellumai/design-library/components/toggle";

/**
 * "Show tips" toggle row, rendered inside the Preferences card on
 * Settings → General. Renders nothing while the proactive-tips flag is off.
 */
export function ShowTipsRow() {
  const variant = useProactiveTipsVariant();
  const enabled = tipsEnabledStorage.useValue();

  if (!isProactiveTipsOn(variant)) {
    return null;
  }

  const onToggle = (next: boolean) => {
    tipsEnabledStorage.save(next);
    // The global opt-out signal: the tip card itself has no don't-show-again
    // affordance, so this toggle is the only place it can be observed.
    if (!next) {
      emitTipEvent("settings", "dont_show_again", variant);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-body-medium-lighter text-[var(--content-default)]">
          Show tips
        </div>
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          Occasional tips in the sidebar that highlight features you haven't
          tried yet.
        </p>
      </div>
      <Toggle checked={enabled} onChange={onToggle} aria-label="Show tips" />
    </div>
  );
}
