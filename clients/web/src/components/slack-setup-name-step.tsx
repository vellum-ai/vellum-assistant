import { Check, ClipboardCopy } from "lucide-react";

import { Button, Input, Typography } from "@vellumai/design-library";
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
  const nameValid = appName.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        Name your Slack app and copy its manifest. Every permission and setting
        comes pre-configured.
      </Typography>

      <Input
        label="App Name"
        value={appName}
        onChange={(e) =>
          onAppNameChange(e.target.value.slice(0, SLACK_APP_NAME_MAX_LENGTH))
        }
        placeholder="My Assistant"
        fullWidth
      />

      <Input
        label="Description (optional)"
        value={description}
        onChange={(e) =>
          onDescriptionChange(
            e.target.value.slice(0, SLACK_APP_DESCRIPTION_MAX_LENGTH),
          )
        }
        placeholder="What this assistant helps with"
        helperText="Shown on the app's Slack profile."
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
          {copied ? "Copied!" : "Copy manifest"}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!nameValid}
          onClick={onContinue}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
