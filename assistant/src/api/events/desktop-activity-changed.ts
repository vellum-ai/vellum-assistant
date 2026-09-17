import { z } from "zod";

/** Transient browser activity changed; refetch desktop status. */
export const DesktopActivityChangedEventSchema = z.object({
  type: z.literal("desktop_activity_changed"),
});

export type DesktopActivityChangedEvent = z.infer<
  typeof DesktopActivityChangedEventSchema
>;
