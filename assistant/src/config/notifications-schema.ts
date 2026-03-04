import { z } from "zod";

export const NotificationsConfigSchema = z.object({
  decisionModelIntent: z
    .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
      error: "notifications.decisionModelIntent must be a valid model intent",
    })
    .default("latency-optimized"),
});

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
