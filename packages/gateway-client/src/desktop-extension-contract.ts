import { z } from "zod";

const packageData = z
  .string()
  .min(1)
  .max(4 * 1024 * 1024)
  .base64();

export const ProvisionDesktopExtensionParamsSchema = z
  .object({
    zip: packageData,
  })
  .strict();

export const ProvisionDesktopExtensionResultSchema = z
  .object({
    id: z.string().regex(/^[a-p]{32}$/),
    crx: packageData,
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
