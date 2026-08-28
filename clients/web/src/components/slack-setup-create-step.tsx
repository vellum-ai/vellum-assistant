import { Button, Notice, Typography } from "@vellumai/design-library";

import { Trans, useTranslation } from "@/i18n";

export interface SlackSetupCreateStepProps {
  onContinue: () => void;
}

/**
 * Step 3 of `SlackSetupWizard`: what to do inside Slack.
 *
 * These directions stay on screen while the user works in the other tab, so
 * this step holds no handoff control of its own. Reopening Slack means
 * stepping back, which the stepper already allows.
 */
export function SlackSetupCreateStep({
  onContinue,
}: SlackSetupCreateStepProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        {t("slackSetupCreateStep.inSlack")}
      </Typography>
      <ol className="list-decimal list-outside space-y-1 pl-5 text-body-medium-lighter text-[var(--content-default)]">
        <li>
          <Trans
            ns="common"
            i18nKey="slackSetupCreateStep.stepManifest"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>{t("slackSetupCreateStep.stepPaste")}</li>
        <li>
          <Trans
            ns="common"
            i18nKey="slackSetupCreateStep.stepReview"
            components={{ strong: <strong /> }}
          />
        </li>
      </ol>

      <Notice tone="info">
        <Trans
          ns="common"
          i18nKey="slackSetupCreateStep.approvalNotice"
          components={{ strong: <strong /> }}
        />
      </Notice>

      <Button
        type="button"
        variant="primary"
        className="self-start"
        onClick={onContinue}
      >
        {t("slackSetupCreateStep.createdApp")}
      </Button>
    </div>
  );
}
