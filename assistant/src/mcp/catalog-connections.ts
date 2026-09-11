import { randomUUID } from "node:crypto";

import { loadRawConfig, saveRawConfig } from "../config/loader.js";
import type { McpConfig } from "../config/schemas/mcp.js";
import { reloadMcpServers } from "../daemon/mcp-reload-service.js";
import {
  BadRequestError,
  InternalError,
  NotFoundError,
} from "../runtime/routes/errors.js";
import { getLogger } from "../util/logger.js";
import { getMcpCatalog } from "./catalog.js";
import { withMcpConfigWrite } from "./connection-lifecycle.js";
import { parseStandardDefinitions } from "./standard-definitions.js";
import { publishMcpChanged } from "./sync.js";

const log = getLogger("mcp-catalog-connections");

export interface CatalogConnectRequest {
  catalogId: string;
  serverKey: string;
  definitionDigest: string;
  setupAcknowledged?: boolean;
}

export async function connectMcpCatalogEntry(
  request: CatalogConnectRequest,
): Promise<{
  serverId: string;
  created: boolean;
}> {
  const entry = getMcpCatalog().find(
    (candidate) =>
      candidate.id === request.catalogId &&
      candidate.serverKey === request.serverKey,
  );
  if (!entry) {
    throw new NotFoundError("This integration is not available in the catalog");
  }
  if (entry.definitionDigest !== request.definitionDigest) {
    throw new BadRequestError(
      "This integration definition changed; refresh the catalog and try again",
    );
  }
  if (entry.setup.mode === "manual" && !request.setupAcknowledged) {
    throw new BadRequestError(
      "Complete this integration's setup requirements before connecting",
    );
  }
  const definition = parseStandardDefinitions(
    entry.documents.plugin,
    entry.documents.mcp,
  );
  if (!definition.ok || !definition.servers[entry.serverKey]) {
    throw new InternalError(
      "This integration's server definition is unavailable",
    );
  }

  const result = await withMcpConfigWrite(async () => {
    const raw = loadRawConfig();
    const mcp = (raw.mcp ??= { servers: {} }) as Partial<McpConfig>;
    const servers = (mcp.servers ??= {});
    const existing = Object.entries(servers).find(
      ([, server]) =>
        server.catalog?.id === entry.id &&
        server.catalog.serverKey === entry.serverKey,
    );
    if (existing) {
      return { serverId: existing[0], created: false };
    }
    const serverId = `catalog-${entry.id}-${randomUUID()}`;
    servers[serverId] = {
      transport: definition.servers[entry.serverKey],
      catalog: {
        id: entry.id,
        serverKey: entry.serverKey,
        definitionDigest: entry.definitionDigest,
      },
    };
    saveRawConfig(raw);
    return { serverId, created: true };
  });

  if (result.created) {
    await publishMcpChanged();
    void reloadMcpServers().catch((error) => {
      log.warn({ error }, "Catalog connection reload failed");
    });
  }
  return result;
}
