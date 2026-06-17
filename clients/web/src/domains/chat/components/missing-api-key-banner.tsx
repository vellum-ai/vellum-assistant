
import { X } from "lucide-react";

import { Button } from "@vellumai/design-library";

export interface MissingApiKeyBannerProps {
  onOpenSettings: () => void;
  onDismiss: () => void;
}

export function MissingApiKeyBanner({
  onOpenSettings,
  onDismiss,
}: MissingApiKeyBannerProps) {
  return (
    <div
      className="relative flex flex-col gap-3 bg-[var(--surface-active)] p-4"
      style={{ borderRadius: "10px 10px 0 0" }}
      role="status"
      aria-label="API key required"
      data-testid="missing-api-key-banner"
    >
      <div className="absolute right-2 top-2">
        <Button
          variant="ghost"
          size="compact"
          iconOnly={<X />}
          tooltip="Dismiss"
          aria-label="Dismiss API key required alert"
          onClick={onDismiss}
        />
      </div>

      <div className="flex flex-col gap-2 pr-8">
        <p className="text-body-small-emphasised text-[var(--content-default)]">
          API key required
        </p>
        <p className="text-body-medium-default text-[var(--content-tertiary)]">
          Add an API key in Settings → Models & Services to start chatting.
        </p>
      </div>

      <Button variant="primary" onClick={onOpenSettings}>
        Open Settings
      </Button>
    </div>
  );
}
