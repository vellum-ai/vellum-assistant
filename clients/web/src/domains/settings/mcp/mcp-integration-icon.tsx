import { Puzzle } from "lucide-react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";

import { getMcpFaviconUrl } from "./mcp-favicon";

interface McpIntegrationIconProps {
  providerKey?: string;
  endpointUrl?: string;
  logoUrl?: string | null;
  size?: number;
}

export function McpIntegrationIcon({
  providerKey = "",
  endpointUrl,
  logoUrl = null,
  size = 32,
}: McpIntegrationIconProps) {
  return (
    <IntegrationIcon
      providerKey={providerKey}
      displayName={null}
      logoUrl={logoUrl}
      fallbackLogoUrl={getMcpFaviconUrl(endpointUrl)}
      size={size}
      fallback={
        <span
          aria-hidden="true"
          style={{ width: size, height: size }}
          className="flex shrink-0 items-center justify-center rounded-md bg-[var(--surface-base)] text-[var(--content-secondary)]"
        >
          <Puzzle size={size * 0.625} />
        </span>
      }
    />
  );
}
