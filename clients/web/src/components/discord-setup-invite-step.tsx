import { Button, Notice, Typography } from "@vellumai/design-library";
import { useTranslation } from "@/i18n";

export interface DiscordSetupInviteStepProps {
  /** The connected application, when the token has been validated. */
  applicationId?: string;
  onOpenInvite: (url: string) => void;
}

/**
 * Invite the bot to a server.
 *
 * The link carries only the client id, which is Discord's current model: the
 * scopes and permissions it asks for come from the application's own Default
 * Install Settings on the portal's Installation page. Spelling them into the
 * URL would override whatever was configured there without saying so.
 */
export function DiscordSetupInviteStep({
  applicationId,
  onOpenInvite,
}: DiscordSetupInviteStepProps) {
  const { t } = useTranslation();

  if (!applicationId) {
    return (
      <Notice tone="warning">{t("discordSetupInviteStep.noAppId")}</Notice>
    );
  }

  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(
    applicationId,
  )}`;

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        {t("discordSetupInviteStep.instructions")}
      </Typography>

      <Button type="button" onClick={() => onOpenInvite(inviteUrl)}>
        {t("discordSetupInviteStep.openInvite")}
      </Button>
    </div>
  );
}
