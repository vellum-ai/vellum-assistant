import { Check, ClipboardCopy } from "lucide-react";

import { Button, Input, Typography } from "@vellumai/design-library";
import { useTranslation } from "@/i18n";
import {
  SLACK_APP_DESCRIPTION_MAX_LENGTH,
  SLACK_APP_NAME_MAX_LENGTH,
} from "@/utils/slack-manifest";

export interface SlackSetupNameStepProps {
  appName: string;
  description: string;
  copied: boolean;
  onAppNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onCopyManifest: () => void;
  onContinue: () => void;
}

/**
 * Step 1 of `SlackSetupWizard`: name the app and take its manifest.
 *
 * Copying and continuing are separate controls. Folding them together meant a
 * copy could not be repeated without navigating, and made moving forward
 * depend on a clipboard write that can fail. The next step offers the manifest
 * again, so nothing is lost by continuing without copying here.
 */
export function SlackSetupNameStep({
  appName,
  description,
  copied,
  onAppNameChange,
  onDescriptionChange,
  onCopyManifest,
  onContinue,
}: SlackSetupNameStepProps) {
  const { t } = useTranslation();
  const nameValid = appName.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        {t("slackSetupNameStep.intro")}
      </Typography>

      <Input
        label={t("slackSetupNameStep.appName")}
        value={appName}
        onChange={(e) =>
          onAppNameChange(e.target.value.slice(0, SLACK_APP_NAME_MAX_LENGTH))
        }
        placeholder={t("slackSetupNameStep.appNamePlaceholder")}
        fullWidth
      />

      <Input
        label={t("slackSetupNameStep.description")}
        value={description}
        onChange={(e) =>
          onDescriptionChange(
            e.target.value.slice(0, SLACK_APP_DESCRIPTION_MAX_LENGTH),
          )
        }
        placeholder={t("slackSetupNameStep.descriptionPlaceholder")}
        helperText={t("slackSetupNameStep.descriptionHelper")}
        fullWidth
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outlined"
          disabled={!nameValid}
          onClick={onCopyManifest}
          leftIcon={
            copied ? (
              <Check aria-hidden className="size-4" />
            ) : (
              <ClipboardCopy aria-hidden className="size-4" />
            )
          }
        >
          {copied
            ? t("slackSetupNameStep.copied")
            : t("slackSetupNameStep.copyManifest")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!nameValid}
          onClick={onContinue}
        >
          {t("slackSetupNameStep.next")}
        </Button>
      </div>
    </div>
  );
}
