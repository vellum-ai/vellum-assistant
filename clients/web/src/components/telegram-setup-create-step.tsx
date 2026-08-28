import { Check, ClipboardCopy, ExternalLink } from "lucide-react";

import { Button, Notice, Typography } from "@vellumai/design-library";

import { Trans, useTranslation } from "@/i18n";

export interface TelegramSetupCreateStepProps {
  /** Suggested display name, offered for the prompt BotFather asks first. */
  suggestedName: string;
  copied: boolean;
  onCopyName: () => void;
  onOpenBotFather: () => void;
  onContinue: () => void;
}

/**
 * Step 1 of `TelegramSetupWizard`: create the bot in BotFather.
 *
 * Opening BotFather does not advance, for the same reason the Slack wizard
 * does not: a blocked popup would move the flow past a tab that never opened.
 */
export function TelegramSetupCreateStep({
  suggestedName,
  copied,
  onCopyName,
  onOpenBotFather,
  onContinue,
}: TelegramSetupCreateStepProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        <Trans
          ns="common"
          i18nKey="telegramSetupCreateStep.intro"
          components={{ strong: <strong /> }}
        />
      </Typography>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="primary"
          onClick={onOpenBotFather}
          rightIcon={<ExternalLink aria-hidden className="size-4" />}
        >
          {t("telegramSetupCreateStep.openBotFather")}
        </Button>
        <Button type="button" variant="outlined" onClick={onContinue}>
          {t("telegramSetupCreateStep.next")}
        </Button>
      </div>

      <Notice
        tone="neutral"
        actions={
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
              ? t("telegramSetupCreateStep.copied")
              : t("telegramSetupCreateStep.copyName")}
          </Button>
        }
      >
        <Trans
          ns="common"
          i18nKey="telegramSetupCreateStep.displayNameHint"
          values={{ suggestedName }}
          components={{ strong: <strong /> }}
        />
      </Notice>

      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        {t("telegramSetupCreateStep.inBotFather")}
      </Typography>
      <ol className="list-decimal list-outside space-y-1 pl-5 text-body-medium-lighter text-[var(--content-default)]">
        <li>
          <Trans
            ns="common"
            i18nKey="telegramSetupCreateStep.stepSendNewBot"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>{t("telegramSetupCreateStep.stepDisplayName")}</li>
        <li>
          <Trans
            ns="common"
            i18nKey="telegramSetupCreateStep.stepUsername"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            ns="common"
            i18nKey="telegramSetupCreateStep.stepTokenReply"
            components={{ strong: <strong /> }}
          />
        </li>
      </ol>
    </div>
  );
}
