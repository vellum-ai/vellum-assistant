import { Check, ClipboardCopy, ExternalLink } from "lucide-react";

import { Button, Typography } from "@vellumai/design-library";

export interface SlackSetupOpenStepProps {
  copied: boolean;
  onOpenSlack: () => void;
  onCopyManifest: () => void;
}

/**
 * Step 2 of `SlackSetupWizard`: hand off to Slack.
 *
 * "Open Slack" also advances, so this step carries one forward action and the
 * directions for what to do over there get a screen of their own. Copying
 * again is deliberately not a forward action: it exists for a clipboard
 * clobbered between steps, and advancing on it would skip the handoff.
 */
export function SlackSetupOpenStep({
  copied,
  onOpenSlack,
  onCopyManifest,
}: SlackSetupOpenStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        The manifest is on your clipboard. Open Slack to create the app, then
        come back here.
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
    </div>
  );
}
