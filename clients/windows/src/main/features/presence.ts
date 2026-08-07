import { installAvatarIpc } from "@vellumai/electron-desktop/avatar";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import { installConnectivityProbe } from "@vellumai/electron-desktop/connectivity-probe";
import { installIdentityIpc } from "@vellumai/electron-desktop/identity";
import { installPowerEvents } from "@vellumai/electron-desktop/power-events";
import { configurePresenceRuntime } from "@vellumai/electron-desktop/presence-runtime";
import {
  installConnectivityIpc,
  installStatusIpc,
} from "@vellumai/electron-desktop/status";
import { resolveLockfilePaths } from "@vellumai/local-mode";

import { handle, on } from "../ipc.client";
import log from "../logger";
import { current } from "../main-window";
import { installTaskbar } from "../taskbar";
import { getTrayIcon, installWindowsTray } from "../tray";

const presence: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "presence",
  install: () => {
    configurePresenceRuntime({ ipc: { handle, on }, logger: log });
    installAvatarIpc();
    installIdentityIpc();
    installPowerEvents();
    installStatusIpc();
    const retryProbe = installConnectivityProbe(
      resolveLockfilePaths(process.env),
    );
    installConnectivityIpc(retryProbe);
    installWindowsTray();
    installTaskbar({ getWindow: current, overlayIcon: getTrayIcon() });
  },
};

export default presence;
