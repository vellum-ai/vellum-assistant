/**
 * Installs the shared host-proxy bridge with the Windows runtime so daemon
 * host_* requests reach the portable executors.
 */

import { app } from "electron";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { getDeviceId } from "@vellumai/electron-desktop/device-id";
import { installHostProxyBridge } from "@vellumai/electron-desktop/host-proxy/router";
import { LOCAL_MODE_CLI } from "@vellumai/electron-desktop/local-mode";
import {
  getWatchedLockfile,
  onLockfileChange,
} from "@vellumai/electron-desktop/lockfile-watcher";
import {
  getSessionToken,
  onSessionTokenChange,
} from "@vellumai/electron-desktop/session-token-store";
import {
  getGuardianAccessToken,
  resolveConfigDir,
  resolveEnvironmentName,
} from "@vellumai/local-mode";

import { createWindowsHostProxyRuntime } from "../host-proxy-adapter";
import log from "../logger";
import { installPresenceMonitor } from "../presence";
import { COMPUTER_USE_ACTION_EXECUTORS } from "./computer-use-actions";

const hostProxy: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "host-proxy",
  install: (capabilities) => {
    // Deferred one microtask: capability modules install synchronously in
    // path order, and the bridge seeds its connections from the lockfile
    // watcher's cache, which the presence module (sorted later) fills with
    // its initial synchronous read. Deferring lets the bridge observe
    // assistants already present at startup.
    queueMicrotask(() => {
      installBridge(capabilities);
    });
  },
};

const installBridge = (capabilities: DesktopCapabilityRegistry): void => {
  const teardown = installHostProxyBridge(
    createWindowsHostProxyRuntime({
      acquireGuardianToken: async (assistantId) => {
        // Resolved lazily so this module works regardless of when (or
        // whether) the CLI provider registers. Without it, local
        // assistants stay explicitly unreachable; cloud assistants use
        // the session token instead.
        const cli = capabilities.get(LOCAL_MODE_CLI);
        if (!cli) {
          log.warn(
            "[host-proxy] no CLI provider registered, skipping local assistant",
            { assistantId },
          );
          return null;
        }
        const result = await getGuardianAccessToken(
          assistantId,
          resolveConfigDir(process.env),
          await cli.resolveInvocation(),
          true,
          { VELLUM_ENVIRONMENT: resolveEnvironmentName(process.env) },
        );
        if (!result.ok) {
          log.warn("[host-proxy] failed to obtain guardian token", {
            assistantId,
            error: result.error,
          });
          return null;
        }
        return result.accessToken;
      },
      getSessionToken,
      onSessionTokenChange,
      getLockfile: getWatchedLockfile,
      onLockfileChange,
      installPresenceMonitor,
      getClientId: getDeviceId,
      computerUseExecutors: capabilities.get(COMPUTER_USE_ACTION_EXECUTORS),
      logger: log,
    }),
  );
  app.once("before-quit", teardown);
};

export default hostProxy;
