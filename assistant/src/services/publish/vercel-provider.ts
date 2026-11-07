/**
 * Vercel publish provider: deploys the compiled app as a static Vercel
 * production deployment. The shipped default.
 */

import { deployHtmlToVercel } from "../vercel-deploy.js";
import type {
  AppPublishMeta,
  PublishProvider,
  PublishResult,
} from "./types.js";

export const vercelPublishProvider: PublishProvider = {
  id: "vercel",
  displayName: "Vercel",
  credential: {
    service: "vercel",
    field: "api_token",
    required: true,
    missingMessage: "Vercel API token not configured",
  },

  async deploy(
    html: string,
    meta: AppPublishMeta,
    token: string | null,
  ): Promise<PublishResult> {
    if (!token) {
      throw new Error("Vercel API token not configured");
    }
    // The slug is the Vercel project name.
    return deployHtmlToVercel({ html, name: meta.slug, token });
  },
};
