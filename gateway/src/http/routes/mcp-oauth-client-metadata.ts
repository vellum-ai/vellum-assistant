import {
  buildMcpOAuthCallbackUrl,
  buildMcpOAuthClientMetadata,
  buildMcpOAuthClientMetadataUrl,
} from "@vellumai/service-contracts/mcp-oauth";
import { normalizeHttpPublicBaseUrlWithoutTrailingSlash } from "@vellumai/service-contracts/ingress";

import type { ConfigFileCache } from "../../config-file-cache.js";

type MetadataConfig = Pick<ConfigFileCache, "getBoolean" | "getString">;

export function createMcpOAuthClientMetadataHandler(
  configFile: MetadataConfig,
) {
  return (): Response => {
    const ingressEnabled = configFile.getBoolean("ingress", "enabled", {
      force: true,
    });
    const publicBaseUrl = normalizeHttpPublicBaseUrlWithoutTrailingSlash(
      configFile.getString("ingress", "publicBaseUrl", { force: true }),
    );

    if (
      ingressEnabled === false ||
      !publicBaseUrl ||
      new URL(publicBaseUrl).protocol !== "https:"
    ) {
      return Response.json(
        { error: "MCP OAuth client metadata is unavailable" },
        { status: 503 },
      );
    }

    return Response.json(
      buildMcpOAuthClientMetadata({
        clientId: buildMcpOAuthClientMetadataUrl(publicBaseUrl),
        redirectUris: [buildMcpOAuthCallbackUrl(publicBaseUrl)],
      }),
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  };
}
