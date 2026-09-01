/**
 * Postinstall adapter that massages the upstream OpenSEO Claude/Cursor plugin
 * into a plugin the Vellum loader can run.
 *
 * Why this exists: OpenSEO (https://github.com/every-app/open-seo) ships a
 * Claude/Cursor plugin at `plugins/openseo` with `skills/` and an `mcp.json`
 * whose server entries omit the transport `type` Vellum requires
 * (`streamable-http` / `sse` / `stdio`), or use the Claude-style `http`
 * alias. Installed verbatim, the skills load but the hosted MCP server is
 * skipped as an invalid entry, so keyword research and the other workflows
 * have no data source.
 *
 * This adapter is curated, reviewed Vellum code (it lives in our repo, not
 * the upstream clone) and is invoked via npm's native `scripts.postinstall`
 * after the installer overlays it onto the freshly cloned tree. It never
 * executes OpenSEO's own lifecycle scripts. It performs a deterministic,
 * file-only translation: rewrite each HTTP URL server in `mcp.json` to
 * `type: "streamable-http"` when the type is missing or is the `http` alias.
 *
 * The installer owns the plugin's `package.json`: when upstream ships none,
 * the overlaid stub becomes the base, then the spent `postinstall` script
 * is dropped. This adapter never touches `package.json`.
 *
 * Runs with the staged install directory as its working directory. Any
 * missing or empty input throws, which fails the install (the installer
 * rolls back staging) rather than materializing a plugin whose MCP server
 * silently does nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MCP_MANIFEST = "mcp.json";
const HTTP_URL_TYPES = new Set(["streamable-http", "sse"]);
const root = process.cwd();

/** Read a required file from the staged tree, failing the install if absent. */
function readRequired(relPath: string): string {
  try {
    return readFileSync(join(root, relPath), "utf8");
  } catch (err) {
    throw new Error(
      `openseo adapter: expected file ${relPath} not found ` +
        `(${err instanceof Error ? err.message : String(err)}). The plugin ` +
        `layout may have changed; the adapter needs updating.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const raw = readRequired(MCP_MANIFEST);
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  throw new Error(
    `openseo adapter: ${MCP_MANIFEST} is not valid JSON ` +
      `(${err instanceof Error ? err.message : String(err)}).`,
  );
}

if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
  throw new Error(
    `openseo adapter: ${MCP_MANIFEST} is missing a valid "mcpServers" object.`,
  );
}

const servers = parsed.mcpServers;
const keys = Object.keys(servers);
if (keys.length === 0) {
  throw new Error(
    `openseo adapter: ${MCP_MANIFEST} declares no MCP servers.`,
  );
}

for (const key of keys) {
  const entry = servers[key];
  if (!isRecord(entry)) {
    throw new Error(
      `openseo adapter: mcpServers.${key} must be an object.`,
    );
  }
  const url = entry.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error(
      `openseo adapter: mcpServers.${key} is missing a non-empty "url".`,
    );
  }
  const type = entry.type;
  if (type === undefined || type === "http") {
    entry.type = "streamable-http";
    continue;
  }
  if (typeof type !== "string" || !HTTP_URL_TYPES.has(type)) {
    throw new Error(
      `openseo adapter: mcpServers.${key} has unsupported type ` +
        `${JSON.stringify(type)}; expected streamable-http, sse, or the ` +
        `Claude-style http alias.`,
    );
  }
}

writeFileSync(
  join(root, MCP_MANIFEST),
  `${JSON.stringify(parsed, null, 2)}\n`,
  "utf8",
);
