import { DetailCard } from "@/components/detail-card";
import { isMacOSBrowser } from "@/runtime/platform-detection";
import { cmdEnterToSend } from "@/utils/composer-settings";
import { isPointerCoarse } from "@/utils/pointer";
import { Toggle } from "@vellumai/design-library/components/toggle";

/**
 * General-settings card for the composer's Enter-key behavior, at parity
 * with the macOS app's "Send with Cmd+Enter" toggle.
 */
export function ComposerSendCard() {
  const enabled = cmdEnterToSend.useValue();

  // On touch devices the composer never submits on Enter (it always inserts
  // a newline; sending happens via the send button), so the toggle would be
  // a no-op control.
  if (isPointerCoarse()) return null;

  const modifier = isMacOSBrowser() ? "Cmd" : "Ctrl";

  return (
    <DetailCard title="Composer">
      <Toggle
        checked={enabled}
        onChange={cmdEnterToSend.save}
        label={`Send with ${modifier}+Enter`}
        helperText={`When enabled, Enter inserts a new line and ${modifier}+Enter sends.`}
      />
    </DetailCard>
  );
}
