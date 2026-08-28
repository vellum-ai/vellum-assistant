import { ChannelAvatarDownload } from "@/components/channel-avatar-download";
import { Button, Typography } from "@vellumai/design-library";
import { Trans, useTranslation } from "@/i18n";

export interface DiscordSetupCreateStepProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
  onOpenPortal: () => void;
  onContinue: () => void;
}

/**
 * Create the application and collect its token.
 *
 * Discord shows a bot token once, at the moment it is generated, and offers
 * no way to read it back, so the copy tells someone to bring it here before
 * leaving the page rather than after.
 *
 * No privileged intents are requested. The client identifies with GUILDS,
 * GUILD_MESSAGES and DIRECT_MESSAGES only, and every message it acts on falls
 * inside Discord's Message Content exemptions: DMs with the app, and messages
 * that mention it.
 */
export function DiscordSetupCreateStep({
  assistantId,
  onOpenPortal,
  onContinue,
}: DiscordSetupCreateStepProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        <Trans
          i18nKey="discordSetupCreateStep.instructions"
          components={{ resetLine: <strong /> }}
        />
      </Typography>

      <Typography
        as="p"
        variant="body-small-default"
        className="text-[color:var(--content-secondary)]"
      >
        {t("discordSetupCreateStep.intentsNote")}
      </Typography>

      <ChannelAvatarDownload assistantId={assistantId} channel="discord" />

      <div className="flex gap-2">
        <Button type="button" variant="outlined" onClick={onOpenPortal}>
          {t("discordSetupCreateStep.openPortal")}
        </Button>
        <Button type="button" onClick={onContinue}>
          {t("discordSetupCreateStep.continue")}
        </Button>
      </div>
    </div>
  );
}
