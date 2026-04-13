export const TELEGRAM_CHANNEL_TRANSPORT_HINTS = [
  "chat-first-medium",
  "channel-safe-onboarding",
  "defer-dashboard-only-tasks",
] as const;
export const TELEGRAM_CHANNEL_TRANSPORT_UX_BRIEF =
  "Telegram is chat-only. Complete channel-safe steps in-channel and defer dashboard-only tasks to desktop.";

export function buildTelegramTransportMetadata(): {
  hints: string[];
  uxBrief: string;
} {
  return {
    hints: [...TELEGRAM_CHANNEL_TRANSPORT_HINTS],
    uxBrief: TELEGRAM_CHANNEL_TRANSPORT_UX_BRIEF,
  };
}

export const WHATSAPP_CHANNEL_TRANSPORT_HINTS = [
  "chat-first-medium",
  "channel-safe-onboarding",
  "defer-dashboard-only-tasks",
  "whatsapp-formatting",
] as const;

export const WHATSAPP_CHANNEL_TRANSPORT_UX_BRIEF =
  "WhatsApp is a mobile messaging channel. Keep responses concise and use plain text; avoid markdown tables and complex formatting.";

export function buildWhatsAppTransportMetadata(): {
  hints: string[];
  uxBrief: string;
} {
  return {
    hints: [...WHATSAPP_CHANNEL_TRANSPORT_HINTS],
    uxBrief: WHATSAPP_CHANNEL_TRANSPORT_UX_BRIEF,
  };
}

export const EMAIL_CHANNEL_TRANSPORT_HINTS = [
  "email-medium",
  "defer-dashboard-only-tasks",
] as const;

export const EMAIL_CHANNEL_TRANSPORT_UX_BRIEF =
  "Email is an asynchronous medium. Responses can be longer and more detailed than chat. Use proper formatting. The user may not see the response immediately. To reply, you should almost always use the `assistant email send` CLI command (run `assistant email send --help` for usage). Use your judgment — there may be rare cases where a different medium is more appropriate or no reply is needed.";

/**
 * Context from the inbound email that the assistant needs to construct a
 * reply via the `assistant email send` CLI command.
 */
export interface EmailReplyContext {
  /** The sender's email address (who the reply should go to). */
  senderAddress: string;
  /** The assistant's own email address (the "from" for the reply). */
  recipientAddress: string;
  /** Original email subject line, if present. */
  subject?: string;
  /** Message-ID of the inbound email for In-Reply-To threading. */
  inReplyTo?: string;
}

export function buildEmailTransportMetadata(replyContext?: EmailReplyContext): {
  hints: string[];
  uxBrief: string;
} {
  const hints: string[] = [...EMAIL_CHANNEL_TRANSPORT_HINTS];

  if (replyContext) {
    hints.push(
      `email-sender: ${replyContext.senderAddress}`,
      `email-recipient: ${replyContext.recipientAddress}`,
    );
    if (replyContext.subject) {
      hints.push(`email-subject: ${replyContext.subject}`);
    }
    if (replyContext.inReplyTo) {
      hints.push(`email-in-reply-to: ${replyContext.inReplyTo}`);
    }
    hints.push(
      "email-reply-help: Run `assistant email send --help` for send usage.",
    );
  }

  return {
    hints,
    uxBrief: EMAIL_CHANNEL_TRANSPORT_UX_BRIEF,
  };
}
