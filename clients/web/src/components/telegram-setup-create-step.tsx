import { Check, ClipboardCopy, ExternalLink } from "lucide-react";

import { Button, Notice, Typography } from "@vellumai/design-library";

export interface TelegramSetupCreateStepProps {
  /** Suggested display name, offered for the prompt BotFather asks first. */
  suggestedName: string;
  copied: boolean;
  onCopyName: () => void;
  onOpenBotFather: () => void;
  onContinue: () => void;
}

/**
 * Step 1 of `TelegramSetupWizard`: create the bot in BotFather.
 *
 * Opening BotFather does not advance, for the same reason the Slack wizard
 * does not: a blocked popup would move the flow past a tab that never opened.
 */
export function TelegramSetupCreateStep({
  suggestedName,
  copied,
  onCopyName,
  onOpenBotFather,
  onContinue,
}: TelegramSetupCreateStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        Telegram bots are created by messaging <strong>@BotFather</strong>. Open
        it, run through the prompts, then come back with the token it gives you.
      </Typography>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="primary"
          onClick={onOpenBotFather}
          rightIcon={<ExternalLink aria-hidden className="size-4" />}
        >
          Open BotFather
        </Button>
        <Button type="button" variant="outlined" onClick={onContinue}>
          Next
        </Button>
      </div>

      <Notice
        tone="neutral"
        actions={
          <Button
            type="button"
            variant="outlined"
            size="compact"
            onClick={onCopyName}
            leftIcon={
              copied ? (
                <Check aria-hidden className="size-4" />
              ) : (
                <ClipboardCopy aria-hidden className="size-4" />
              )
            }
          >
            {copied ? "Copied!" : "Copy name"}
          </Button>
        }
      >
        For the display name, <strong>{suggestedName}</strong> keeps this bot
        matching your assistant. The username is separate and does not have to
        match.
      </Notice>

      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        In BotFather:
      </Typography>
      <ol className="list-decimal list-outside space-y-1 pl-5 text-body-medium-lighter text-[var(--content-default)]">
        <li>
          Send <strong>/newbot</strong>
        </li>
        <li>Give it a display name, which is what people see in chat</li>
        <li>
          Give it a username, which must be unique and end in{" "}
          <strong>bot</strong>
        </li>
        <li>
          BotFather replies with a token after{" "}
          <strong>Use this token to access the HTTP API</strong>
        </li>
      </ol>
    </div>
  );
}
