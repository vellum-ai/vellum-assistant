import { z } from "zod";

/**
 * How a service family obtains its upstream: through the Vellum platform
 * ("managed", billed to the org) or with credentials the user brought
 * ("your-own"). Lives apart from `services.ts` so family schemas that
 * `services.ts` composes can import it without a cycle.
 */
export const ServiceModeSchema = z
  .enum(["managed", "your-own"])
  .meta({ id: "ServiceMode" });
export type ServiceMode = z.infer<typeof ServiceModeSchema>;
