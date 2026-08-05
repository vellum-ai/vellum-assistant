import { Check, ClipboardCopy } from "lucide-react";

import { Button, Input, Typography } from "@vellumai/design-library";

/** Slack's limit for `display_information.name`. */
const APP_NAME_MAX_LENGTH = 35;

/** Slack's limit for `display_information.description`. */
const DESCRIPTION_MAX_LENGTH = 140;

export interface SlackSetupNameStepProps {
  appName: string;
  description: string;
  copied: boolean;
  onAppNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onCopyAndContinue: () => void;
}

/**
 * Step 1 of `SlackSetupWizard`: name the app and take its manifest.
 *
 * Copying and advancing are one action rather than two controls, so the
 * manifest is on the clipboard before the next step sends anyone to Slack.
 * Slack's create-app modal has nowhere to fetch it from.
 */
export function SlackSetupNameStep({
  appName,
  description,
  copied,
  onAppNameChange,
  onDescriptionChange,
  onCopyAndContinue,
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
          onAppNameChange(e.target.value.slice(0, APP_NAME_MAX_LENGTH))
        }
        placeholder="My Assistant"
        fullWidth
      />

      <Input
        label="Description (optional)"
        value={description}
        onChange={(e) =>
          onDescriptionChange(e.target.value.slice(0, DESCRIPTION_MAX_LENGTH))
        }
        placeholder="What this assistant helps with"
        helperText="Shown on the app's Slack profile."
        fullWidth
      />

      <div className="flex">
        <Button
          type="button"
          variant="primary"
          disabled={!nameValid}
          onClick={onCopyAndContinue}
          leftIcon={
            copied ? (
              <Check aria-hidden className="size-4" />
            ) : (
              <ClipboardCopy aria-hidden className="size-4" />
            )
          }
        >
          Copy manifest and continue
        </Button>
      </div>
    </div>
  );
}
