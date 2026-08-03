import type { MetadataRoute } from "next";

import {
  discoverDocsRoutes,
  REDIRECT_STUB_ROUTES,
} from "@/lib/discover-docs-routes";
import { SITE_URL } from "@/lib/metadata";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return discoverDocsRoutes()
    .filter((route) => !REDIRECT_STUB_ROUTES.has(route))
    .map((route) => ({
      url: `${SITE_URL}${route}`,
      changeFrequency: "weekly" as const,
    }));
}
