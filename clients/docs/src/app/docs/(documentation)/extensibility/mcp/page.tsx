import { ExtensibilityMcpContent } from "@/app/docs/_components/extensibility-mcp-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "MCP servers - Vellum Docs",
  description:
    "A plugin declares MCP servers in a root mcp.json. The assistant connects them on install and registers their tools alongside workspace-configured MCP tools.",
  path: "/docs/extensibility/mcp",
});

export default function ExtensibilityMcpPage() {
  return <ExtensibilityMcpContent />;
}
