import { Button, Notice, Typography } from "@vellumai/design-library";

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
  return (
    <div className="flex flex-col gap-4">
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

      <Notice tone="info">
        If Slack shows &ldquo;Request approval&rdquo; instead of{" "}
        <strong>Install</strong>, a workspace admin needs to approve the app
        first.
      </Notice>

      <Button
        type="button"
        variant="primary"
        className="self-start"
        onClick={onContinue}
      >
        I created the app
      </Button>
    </div>
  );
}
