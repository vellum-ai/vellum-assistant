import { Check, ClipboardCopy, ExternalLink } from "lucide-react";

import { Button, Typography } from "@vellumai/design-library";

export interface SlackSetupCreateStepProps {
  copied: boolean;
  onOpenSlack: () => void;
  onCopyManifest: () => void;
  onContinue: () => void;
}

/**
 * Step 2 of `SlackSetupWizard`: hand the manifest to Slack.
 *
 * "Open Slack" leads, because everything below it happens in the tab that
 * button opens. The directions stay on screen here for the round trip back.
 */
export function SlackSetupCreateStep({
  copied,
  onOpenSlack,
  onCopyManifest,
  onContinue,
}: SlackSetupCreateStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        The manifest is on your clipboard. Create the app in Slack, then come
        back here.
      </Typography>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="primary"
          onClick={onOpenSlack}
          rightIcon={<ExternalLink aria-hidden className="size-4" />}
        >
          Open Slack
        </Button>
        <Button
          type="button"
          variant="outlined"
          onClick={onCopyManifest}
          leftIcon={
            copied ? (
              <Check aria-hidden className="size-4" />
            ) : (
              <ClipboardCopy aria-hidden className="size-4" />
            )
          }
        >
          {copied ? "Copied!" : "Copy again"}
        </Button>
      </div>

      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        In Slack:
      </Typography>
      <ol className="list-decimal list-outside space-y-1 pl-5 text-body-medium-lighter text-[var(--content-default)]">
        <li>
          Under <strong>Or start your own way</strong>, pick{" "}
          <strong>From a manifest</strong>, then <strong>Continue</strong>
        </li>
        <li>Choose your workspace and paste the manifest</li>
        <li>
          Review the permissions, then click <strong>Create and Install</strong>
        </li>
      </ol>

      <Typography
        as="p"
        variant="body-small-default"
        className="text-[color:var(--content-faint)]"
      >
        If Slack shows &ldquo;Request approval&rdquo; instead of{" "}
        <strong>Install</strong>, a workspace admin needs to approve the app
        first.
      </Typography>

      <div className="flex">
        <Button type="button" variant="primary" onClick={onContinue}>
          I created the app
        </Button>
      </div>
    </div>
  );
}
