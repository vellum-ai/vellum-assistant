import { z } from 'zod';

export const NotificationsConfigSchema = z.object({
  decisionModel: z
    .string({ error: 'notifications.decisionModel must be a string' })
    .default('claude-haiku-4-5-20251001'),
});

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
