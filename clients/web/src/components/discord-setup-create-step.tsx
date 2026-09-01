import { ChannelAvatarDownload } from "@/components/channel-avatar-download";
import { ExternalLink } from "lucide-react";

import { Button, Typography } from "@vellumai/design-library";
import { Trans, useTranslation } from "@/i18n";

export interface DiscordSetupCreateStepProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
  onOpenPortal: () => void;
  onContinue: () => void;
}

/**
 * Create the application and collect its token, laid out as the ordered list
 * of portal actions the user performs, matching the Telegram create step.
 * The avatar download rides inside the icon step it belongs to.
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
        {t("discordSetupCreateStep.inPortal")}
      </Typography>

      <ol className="list-decimal list-outside space-y-1 pl-5 text-body-medium-lighter text-[var(--content-default)]">
        <li>{t("discordSetupCreateStep.stepCreateApp")}</li>
        <li>
          <Trans
            i18nKey="discordSetupCreateStep.stepAppIcon"
            components={{ strong: <strong /> }}
          />
          <div className="mt-1.5 mb-1">
            <ChannelAvatarDownload
              assistantId={assistantId}
              channel="discord"
              compact
            />
          </div>
        </li>
        <li>
          <Trans
            i18nKey="discordSetupCreateStep.stepResetToken"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="discordSetupCreateStep.stepIntentsOff"
            components={{ strong: <strong /> }}
          />
        </li>
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="primary"
          onClick={onOpenPortal}
          rightIcon={<ExternalLink aria-hidden className="size-4" />}
        >
          {t("discordSetupCreateStep.openPortal")}
        </Button>
        <Button type="button" variant="outlined" onClick={onContinue}>
          {t("discordSetupCreateStep.continue")}
        </Button>
      </div>
    </div>
  );
}
