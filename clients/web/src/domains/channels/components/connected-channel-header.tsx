import { Button } from "@vellumai/design-library/components/button";

import { useTranslation } from "@/i18n";
import type { AssistantChannelState } from "@/types/channel-types";

import { ChannelHealthTag } from "./channel-health-tag";

interface ConnectedChannelHeaderProps {
  health?: AssistantChannelState["health"];
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
  health,
  pending,
  onDisconnect,
}: ConnectedChannelHeaderProps) {
  const { t } = useTranslation("channels");
  return (
    <div className="flex items-center gap-3">
      <ChannelHealthTag health={health} />
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
          {pending
            ? t("connectionCard.disconnecting")
            : t("connectionCard.disconnect")}
        </Button>
      </div>
    </div>
  );
}
