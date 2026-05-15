import type { ConfigFileCache } from "../config-file-cache.js";
import { getLogger } from "../logger.js";
import { clearManagedPublicBaseUrl } from "./client.js";

const log = getLogger("velay-startup");

type VelayTunnelStarter = {
  start: () => void;
};

export async function startVelayTunnelOnGatewayBoot(
  velayTunnelClient: VelayTunnelStarter | undefined,
  configFileCache: ConfigFileCache,
): Promise<void> {
  if (!velayTunnelClient) return;

  await clearManagedPublicBaseUrl(configFileCache).catch((err) => {
    log.error({ err }, "Failed to clear stale Velay public URL");
  });
  // Velay backs platform-managed webhook and WebSocket ingress broadly,
  // so start it whenever the gateway has a VELAY_BASE_URL.
  log.info("Starting Velay tunnel");
  velayTunnelClient.start();
}
