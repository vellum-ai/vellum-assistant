import { Check, ClipboardCopy, ExternalLink } from "lucide-react";

import { Button, Notice, Typography } from "@vellumai/design-library";

export interface SlackSetupOpenStepProps {
  /** Whether the clipboard holds the manifest for the app as currently named. */
  manifestOnClipboard: boolean;
  copied: boolean;
  onCopyManifest: () => void;
  onOpenSlack: () => void;
  onContinue: () => void;
}

/**
 * Step 2 of `SlackSetupWizard`: hand off to Slack.
 *
 * Opening Slack does not advance, and copying does not either. A popup blocker
 * or a rejected clipboard write would otherwise move the flow on without the
 * thing it claims to have done.
 *
 * Slack's create-app modal cannot fetch the manifest, so arriving there with an
 * empty or stale clipboard dead-ends. Rather than gate the forward action on a
 * copy, this step reports what is actually on the clipboard and offers to fix
 * it in place. The copy control lives inside that notice rather than beside
 * Open Slack, so the step keeps one primary action.
 */
export function SlackSetupOpenStep({
  manifestOnClipboard,
  copied,
  onCopyManifest,
  onOpenSlack,
  onContinue,
}: SlackSetupOpenStepProps) {
  const copyButton = (
    <Button
      type="button"
      variant="outlined"
      size="compact"
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
  );

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

      {manifestOnClipboard ? (
        <Notice tone="success" actions={copyButton}>
          The manifest is on your clipboard, ready to paste into Slack.
        </Notice>
      ) : (
        <Notice tone="warning" actions={copyButton}>
          Your clipboard does not hold this app&apos;s manifest. Slack&apos;s
          create-app modal has no other way to get it, so copy it before you
          paste.
        </Notice>
      )}

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
