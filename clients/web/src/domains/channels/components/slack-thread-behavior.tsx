import { Radio, RadioGroup } from "@vellumai/design-library/components/radio";
import { Typography } from "@vellumai/design-library/components/typography";

import type { IntegrationsSlackChannelConfigGetResponse } from "@/generated/daemon/types.gen";

export type SlackThreadMode =
  IntegrationsSlackChannelConfigGetResponse["threadMode"];

interface SlackThreadBehaviorProps {
  threadMode?: SlackThreadMode;
  threadModePending?: boolean;
  onThreadModeChange?: (mode: SlackThreadMode) => void;
}

/**
 * Thread Behavior setting for a connected Slack channel: whether the
 * assistant only answers @mentions or follows a thread after its first
 * mention. Rendered inside the connected Slack card on the Channels tab;
 * setup for a disconnected Slack lives in `SlackSetupWizard`.
 */
export function SlackThreadBehavior({
  threadMode,
  threadModePending = false,
  onThreadModeChange,
}: SlackThreadBehaviorProps) {
  return (
    <div className="flex flex-col gap-3">
      <Typography
        as="span"
        variant="body-small-emphasised"
        className="text-[color:var(--content-secondary)]"
      >
        Thread Behavior
      </Typography>
      <RadioGroup<SlackThreadMode>
        value={threadMode ?? "mention_then_thread"}
        onValueChange={(next) => onThreadModeChange?.(next)}
        disabled={threadModePending || !onThreadModeChange}
        aria-label="Slack thread behavior"
      >
        <Radio<SlackThreadMode>
          value="mention_only"
          label="Mentions only"
          helperText="Bot only responds when @mentioned."
        />
        <Radio<SlackThreadMode>
          value="mention_then_thread"
          label="Follow threads after first mention"
          helperText="After an @mention in a thread, bot listens to all subsequent replies."
        />
      </RadioGroup>
    </div>
  );
}
