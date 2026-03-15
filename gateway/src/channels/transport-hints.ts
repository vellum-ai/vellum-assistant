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
