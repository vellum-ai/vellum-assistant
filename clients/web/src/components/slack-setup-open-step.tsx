import { ExternalLink } from "lucide-react";

import { Button, Typography } from "@vellumai/design-library";

export interface SlackSetupOpenStepProps {
  onOpenSlack: () => void;
  onContinue: () => void;
}

/**
 * Step 2 of `SlackSetupWizard`: hand off to Slack.
 *
 * Opening Slack does not advance. A popup blocker or a stolen focus would
 * otherwise move the flow on without the tab it claims to have opened, and
 * navigating for the user is what made the previous shape confusing. To copy
 * the manifest again, step back to Name, which the stepper keeps reachable.
 */
export function SlackSetupOpenStep({
  onOpenSlack,
  onContinue,
}: SlackSetupOpenStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        Open Slack in a new tab to create the app, then come back here for the
        steps to follow.
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
        <Button type="button" variant="outlined" onClick={onContinue}>
          Next
        </Button>
      </div>
    </div>
  );
}
