import { Button, Notice, Typography } from "@vellumai/design-library";
import { useTranslation } from "@/i18n";

export interface DiscordSetupInviteStepProps {
  /**
   * The install link, computed daemon-side from the application's own
   * install settings when the token validates. The grant rules live in one
   * place there; this step only opens what it is handed.
   */
  inviteUrl?: string;
  onOpenInvite: (url: string) => void;
}

/** Invite the bot to a server. */
export function DiscordSetupInviteStep({
  inviteUrl,
  onOpenInvite,
}: DiscordSetupInviteStepProps) {
  const { t } = useTranslation();

  if (!inviteUrl) {
    return (
      <Notice tone="warning">{t("discordSetupInviteStep.noAppId")}</Notice>
    );
  }

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
