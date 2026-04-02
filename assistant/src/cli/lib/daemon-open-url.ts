/**
 * CLI helper for opening URLs via the daemon's `open_url` event broadcast.
 *
 * When the daemon is running and has connected SSE clients (e.g. the Swift
 * desktop app), the URL is published as an `open_url` event so the user's
 * native client opens the browser on their machine — critical for headless
 * daemon deployments where `xdg-open` / `open` do not exist.
 *
 * Falls back to the local `openInBrowser()` helper when the daemon is
 * unreachable (e.g. standalone CLI usage on a developer's laptop).
 */

import { getRuntimeHttpHost, getRuntimeHttpPort } from "../../config/env.js";
import { healthCheckHost, isHttpHealthy } from "../../daemon/daemon-control.js";
import {
  initAuthSigningKey,
  loadOrCreateSigningKey,
  mintDaemonDeliveryToken,
} from "../../runtime/auth/token-service.js";
import { openInBrowser } from "../../util/browser.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("daemon-open-url");

/**
 * Open a URL by broadcasting an `open_url` event through the daemon to
 * connected clients. Falls back to local `openInBrowser()` when the daemon
 * is not reachable.
 */
export async function openUrlViaDaemon(
  url: string,
  title?: string,
): Promise<void> {
  try {
    if (!(await isHttpHealthy())) {
      log.debug("Daemon not reachable — falling back to local openInBrowser");
      openInBrowser(url);
      return;
    }

    const port = getRuntimeHttpPort();
    const host = healthCheckHost(getRuntimeHttpHost());
    initAuthSigningKey(loadOrCreateSigningKey());
    const token = mintDaemonDeliveryToken();

    const res = await fetch(`http://${host}:${port}/v1/open-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, ...(title ? { title } : {}) }),
    });

    if (!res.ok) {
      log.warn(
        { status: res.status },
        "Daemon open-url request returned non-ok status — falling back to local openInBrowser",
      );
      openInBrowser(url);
    }
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Daemon open-url request error — falling back to local openInBrowser",
    );
    openInBrowser(url);
  }
}
