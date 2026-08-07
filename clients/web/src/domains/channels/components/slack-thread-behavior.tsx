import { Radio, RadioGroup } from "@vellumai/design-library/components/radio";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";
import type { IntegrationsSlackChannelConfigGetResponse } from "@/generated/daemon/types.gen";

export type SlackThreadMode =
  IntegrationsSlackChannelConfigGetResponse["threadMode"];

interface SlackThreadBehaviorProps {
  threadMode?: SlackThreadMode;
  threadModePending?: boolean;
  onThreadModeChange?: (mode: SlackThreadMode) => void;
}

/**
 * {t("slackThreadBehavior.heading")} setting for a connected Slack channel: whether the
 * assistant only answers @mentions or follows a thread after its first
 * mention. Rendered inside the connected Slack card on the Channels tab;
 * setup for a disconnected Slack lives in `SlackSetupWizard`.
 */
export function SlackThreadBehavior({
  threadMode,
  threadModePending = false,
  onThreadModeChange,
}: SlackThreadBehaviorProps) {
  const { t } = useTranslation("channels");
  return (
    <div className="flex flex-col gap-3">
      <Typography
        as="span"
        variant="body-small-emphasised"
        className="text-[color:var(--content-secondary)]"
      >
        {t("slackThreadBehavior.heading")}
      </Typography>
      <RadioGroup<SlackThreadMode>
        value={threadMode ?? "mention_then_thread"}
        onValueChange={(next) => onThreadModeChange?.(next)}
        disabled={threadModePending || !onThreadModeChange}
        aria-label={t("slackThreadBehavior.selectAria")}
      >
        <Radio<SlackThreadMode>
          value="mention_only"
          label={t("slackThreadBehavior.mentionsOnly")}
          helperText={t("slackThreadBehavior.mentionsOnlyHelp")}
        />
        <Radio<SlackThreadMode>
          value="mention_then_thread"
          label={t("slackThreadBehavior.followThreads")}
          helperText={t("slackThreadBehavior.followThreadsHelp")}
        />
      </RadioGroup>
    </div>
  );
}
