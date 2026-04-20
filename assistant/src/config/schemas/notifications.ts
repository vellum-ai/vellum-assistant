import { z } from "zod";

export const NotificationsConfigSchema = z
  .object({})
  .describe(
    "Notification delivery configuration. Model selection lives under llm.callSites.notificationDecision and llm.callSites.preferenceExtraction.",
  );

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
