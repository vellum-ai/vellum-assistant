import { z } from "zod";

/** Attention urgency for a notification signal, ordered low → critical. */
export const UrgencySchema = z.enum(["low", "medium", "high", "critical"]);
export type Urgency = z.infer<typeof UrgencySchema>;
