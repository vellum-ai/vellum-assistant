import {
  ChannelAvatarDownload,
  useAvatarRasterUrl,
} from "@/components/channel-avatar-download";
import { Check, ClipboardCopy, ExternalLink } from "lucide-react";

import { Button, Typography } from "@vellumai/design-library";
import { SetupStepList } from "@/components/setup-step-list";
import { Trans, useTranslation } from "@/i18n";

export interface DiscordSetupCreateStepProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
  /** Suggested app name, offered to copy when the portal asks for one. */
  suggestedName: string;
  copied: boolean;
  onCopyName: () => void;
  onOpenPortal: () => void;
  onContinue: () => void;
}

/**
 * Create the application and collect its token, laid out as the ordered list
 * of portal actions the user performs: location first, one action per step,
 * the portal's own labels in bold. The name to copy and the avatar to
 * download ride inside the steps they belong to.
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
  suggestedName,
  copied,
  onCopyName,
  onOpenPortal,
  onContinue,
}: DiscordSetupCreateStepProps) {
  const { t } = useTranslation();
  // The icon step exists only while there is an avatar to download: an
  // instruction to download nothing reads as a broken step, and the app
  // icon is optional anyway.
  const avatarUrl = useAvatarRasterUrl(assistantId);

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        {t("discordSetupCreateStep.inPortal")}
      </Typography>

      <SetupStepList>
        <li>
          <Trans
            i18nKey="discordSetupCreateStep.stepCreateApp"
            components={{ strong: <strong /> }}
          />
          <div className="mt-1.5 mb-1 flex flex-wrap items-center gap-2">
            <Typography
              as="span"
              variant="body-medium-default"
              className="rounded bg-[var(--surface-overlay)] px-1.5 py-0.5 text-[color:var(--content-strong)]"
            >
              {suggestedName}
            </Typography>
            <Button
              type="button"
              variant="outlined"
              size="compact"
              onClick={onCopyName}
              leftIcon={
                copied ? (
                  <Check aria-hidden className="size-4" />
                ) : (
                  <ClipboardCopy aria-hidden className="size-4" />
                )
              }
            >
              {copied
                ? t("discordSetupCreateStep.copied")
                : t("discordSetupCreateStep.copyName")}
            </Button>
          </div>
        </li>
        {avatarUrl ? (
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
        ) : null}
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
      </SetupStepList>

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
