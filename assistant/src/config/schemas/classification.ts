import { z } from "zod";

import { CLASSIFICATION_PROVIDER_IDS } from "../../providers/classification/provider-catalog.js";
import { ServiceModeSchema } from "./service-mode.js";

/**
 * `services.classification`: the decision-model family (see
 * `providers/classification/provider-catalog.ts`).
 *
 * `mode` picks the credential: "your-own" reads the provider's stored key,
 * "managed" routes through the platform runtime proxy on the assistant API
 * key. The family is inert until one of those resolves, so a fresh install
 * with neither stays exactly where it was before the family existed: no
 * judge runs and the memory selector keeps its LLM path.
 */
export const ClassificationServiceSchema = z.object({
  mode: ServiceModeSchema.default("your-own"),
  provider: z.enum(CLASSIFICATION_PROVIDER_IDS).default("typesafe"),
  model: z.string().min(1).default("jev-latest"),
});
export type ClassificationService = z.infer<typeof ClassificationServiceSchema>;
