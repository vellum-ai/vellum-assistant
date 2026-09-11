import { getLogger } from "../util/logger.js";
import bundled from "./bundled-catalog.json" with { type: "json" };
import {
  type BundledMcpCatalogEntry,
  mcpCatalogEntrySchema,
} from "./catalog-schema.js";
import {
  parseStandardDefinitions,
  standardDefinitionDigest,
} from "./standard-definitions.js";

const log = getLogger("mcp-catalog");

export type PublicMcpCatalogEntry = Omit<
  BundledMcpCatalogEntry,
  "packagePath" | "source" | "resolvedSource"
>;

export function getMcpCatalog(): PublicMcpCatalogEntry[] {
  return bundled.entries.flatMap((value: unknown) => {
    const entry = value as BundledMcpCatalogEntry;
    try {
      const {
        documents,
        definitionDigest,
        resolvedSource: _resolved,
        ...index
      } = entry;
      const {
        packagePath: _path,
        source: _source,
        ...metadata
      } = mcpCatalogEntrySchema.parse(index);
      const parsed = parseStandardDefinitions(documents.plugin, documents.mcp);
      if (
        !parsed.ok ||
        !Object.hasOwn(parsed.servers, metadata.serverKey) ||
        standardDefinitionDigest(parsed.documents) !== definitionDigest
      ) {
        throw new Error(
          "Bundled definition does not match its catalog identity",
        );
      }
      return [{ ...metadata, documents: parsed.documents, definitionDigest }];
    } catch (error) {
      log.warn(
        { catalogId: entry?.id, error },
        "Ignoring invalid MCP catalog entry",
      );
      return [];
    }
  });
}
