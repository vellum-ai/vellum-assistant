import { Check, ClipboardCopy, ExternalLink } from "lucide-react";

import { Button, Notice, Typography } from "@vellumai/design-library";

export interface SlackSetupOpenStepProps {
  /**
   * Whether this wizard successfully copied the manifest for the app as
   * currently named. Not a claim about the clipboard's present contents: a
   * page cannot observe those without a permission prompt, and anything the
   * user copies elsewhere replaces them silently.
   */
  manifestCopiedHere: boolean;
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
 * Slack's create-app modal cannot fetch the manifest, so arriving there without
 * it dead-ends. Rather than gate the forward action on a copy, this step
 * reports whether the manifest was copied here and offers to copy it again in
 * place. It deliberately does not claim the clipboard still holds it, because
 * nothing here can know that. The copy control lives inside that notice rather
 * than beside Open Slack, so the step keeps one primary action.
 */
export function SlackSetupOpenStep({
  manifestCopiedHere,
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

      {manifestCopiedHere ? (
        <Notice tone="info" actions={copyButton}>
          You copied this app&apos;s manifest here. If you have copied anything
          since, copy it again before you paste.
        </Notice>
      ) : (
        <Notice tone="warning" actions={copyButton}>
          You have not copied this app&apos;s manifest yet. Slack&apos;s
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
