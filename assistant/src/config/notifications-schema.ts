import { z } from 'zod';

export const NotificationsConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'notifications.enabled must be a boolean' })
    .default(false),
  shadowMode: z
    .boolean({ error: 'notifications.shadowMode must be a boolean' })
    .default(true),
  decisionModel: z
    .string({ error: 'notifications.decisionModel must be a string' })
    .default('claude-haiku-4-5-20251001'),
});

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
