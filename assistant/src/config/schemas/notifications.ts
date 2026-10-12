import { z } from "zod";

export const NotificationsConfigSchema = z
  .object({
    newMessageEnabled: z
      .boolean()
      .default(true)
      .describe(
        "Allow ordinary chat-reply alerts. Does not change unread state or action-required alerts.",
      ),
    allAlertsEnabled: z
      .boolean()
      .default(false)
      .describe(
        "Banner every local notification, not only urgent ones and completions. Explicitly quiet notifications and disabled chat-reply alerts stay silent. Channel routing is unchanged.",
      ),
  })
  .describe(
    "Notification delivery configuration. Model selection lives under llm.callSites.notificationDecision and llm.callSites.preferenceExtraction.",
  );

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
