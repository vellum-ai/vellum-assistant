import { CheckCircle } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

interface ConnectedChannelHeaderProps {
  /** The connected channel's address/handle, when known. */
  address?: string;
  /** Disconnect in flight; disables the button and swaps its label. */
  pending: boolean;
  onDisconnect?: () => void;
}

/**
 * The connected-state header for the single-credential adapters (Telegram,
 * Phone): a Connected chip, the channel address, and a right-aligned
 * Disconnect affordance (the caller confirms first). Slack has its own
 * `SlackConnectionCard`; these channels render inside the panel's DetailCard.
 */
export function ConnectedChannelHeader({
  address,
  pending,
  onDisconnect,
}: ConnectedChannelHeaderProps) {
  return (
    <div className="flex items-center gap-3">
      <Tag tone="positive" leftIcon={<CheckCircle />}>
        Connected
      </Tag>
      {address ? (
        <span
          className="text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          {address}
        </span>
      ) : null}
      <div className="ml-auto">
        <Button
          type="button"
          variant="danger"
          onClick={onDisconnect}
          disabled={!onDisconnect || pending}
        >
          {pending ? "Disconnecting…" : "Disconnect"}
        </Button>
      </div>
    </div>
  );
}
