import type { McpServerEntry } from "./mcp-api";

/**
 * Installing a catalog plugin and signing in to the server it brings.
 *
 * Two surfaces start the same sequence: the tile on the integrations page and
 * the connect dialog over it. It lives here so the order of the steps, the id
 * the attempt carries while the plugin installs, and the rule for which server
 * to authorize are decided once.
 */

/**
 * The id a connect attempt carries before the plugin that owns the real server
 * is installed. `useMcpConnect` swaps it for whatever the preparation resolves,
 * so it only has to be stable for the life of one attempt.
 */
export function provisionalPluginServerId(pluginName: string): string {
  return `plugin:${pluginName}`;
}

/**
 * The one server a freshly installed plugin can sign in to.
 *
 * `null` when the plugin brought none, or brought more than one: nothing here
 * can decide on the user's behalf which of several servers they meant.
 * `useMcpConnect` reads `null` as "there is nothing to authorize", ends the
 * attempt, and leaves the installed plugin in place.
 */
export function pluginAuthTarget(servers: McpServerEntry[]): string | null {
  const candidates = servers.filter(
    (server) =>
      server.transport.type !== "stdio" && server.status !== "connected",
  );
  return candidates.length === 1 ? candidates[0]!.id : null;
}

export interface PluginMcpConnectSteps {
  /** Install the plugin that owns the server. */
  install: () => Promise<unknown>;
  /**
   * Reload the server list and return the ones this plugin owns. An empty
   * array covers a failed reload: there is then nothing to authorize.
   */
  loadPluginServers: () => Promise<McpServerEntry[]>;
}

/**
 * The preparation `useMcpConnect` runs while its authorization window waits:
 * install the plugin, reload the servers it declared, and name the one to
 * sign in to.
 */
export function preparePluginMcpConnect(
  steps: PluginMcpConnectSteps,
): () => Promise<string | null> {
  return async () => {
    await steps.install();
    return pluginAuthTarget(await steps.loadPluginServers());
  };
}
