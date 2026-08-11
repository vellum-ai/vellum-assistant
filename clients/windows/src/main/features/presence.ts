import { app } from "electron";

import { installAvatarIpc } from "@vellumai/electron-desktop/avatar";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { installConnectivityProbe } from "@vellumai/electron-desktop/connectivity-probe";
import { installIdentityIpc } from "@vellumai/electron-desktop/identity";
import {
  configureLockfileWatcher,
  installLockfileWatcher,
} from "@vellumai/electron-desktop/lockfile-watcher";
import { installPowerEvents } from "@vellumai/electron-desktop/power-events";
import { configurePresenceRuntime } from "@vellumai/electron-desktop/presence-runtime";
import {
  installConnectivityIpc,
  installStatusIpc,
} from "@vellumai/electron-desktop/status";
import { resolveLockfilePaths } from "@vellumai/local-mode";

import { handle, on } from "../ipc.client";
import { installFeatureFlagsIpc, isFeatureEnabled } from "../feature-flags";
import log from "../logger";
import { current } from "../main-window";
import { installTaskbar } from "../taskbar";
import { installWindowsTray } from "../tray";

const presence: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "presence",
  install: () => {
    configurePresenceRuntime({ ipc: { handle, on }, logger: log });
    installAvatarIpc();
    installIdentityIpc();
    installFeatureFlagsIpc();
    installPowerEvents();
    installStatusIpc();
    const retryProbe = installConnectivityProbe(
      resolveLockfilePaths(process.env),
    );
    installConnectivityIpc(retryProbe);
    configureLockfileWatcher(() => resolveLockfilePaths(process.env));
    const stopLockfileWatcher = installLockfileWatcher();
    app.once("before-quit", stopLockfileWatcher);
    installWindowsTray(isFeatureEnabled);
    installTaskbar({ getWindow: current });
  },
};

export default presence;
