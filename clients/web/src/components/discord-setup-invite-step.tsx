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
  /**
   * The user says the bot joined. Discord's authorization finishes in a popup
   * this app cannot observe (the token is dropped after save, deliberately),
   * so their word is the only completion signal available.
   */
  onConfirmJoined: () => void;
}

/** Invite the bot to a server. */
export function DiscordSetupInviteStep({
  inviteUrl,
  onOpenInvite,
  onConfirmJoined,
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

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => onOpenInvite(inviteUrl)}>
          {t("discordSetupInviteStep.openInvite")}
        </Button>
        <Button type="button" variant="outlined" onClick={onConfirmJoined}>
          {t("discordSetupInviteStep.confirmJoined")}
        </Button>
      </div>
    </div>
  );
}
