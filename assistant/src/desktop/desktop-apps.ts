import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";
import { CALCULATOR_ICON, EDITOR_ICON } from "./desktop-app-icons.js";
import { installDesktopX11App } from "./desktop-dependencies.js";
import { desktopEntry, seedFile } from "./desktop-panel-config.js";

export const DESKTOP_APPS = [
  {
    id: "calculator",
    name: "Calculator",
    binary: "xcalc",
    windowClass: "XCalc",
    icon: CALCULATOR_ICON,
  },
  {
    id: "text-editor",
    name: "Text Editor",
    binary: "xedit",
    windowClass: "Xedit",
    icon: EDITOR_ICON,
  },
] as const;
export type DesktopApp = (typeof DESKTOP_APPS)[number];
export type DesktopAppState =
  | "available"
  | "installed"
  | "added"
  | "installing"
  | "failed";
const log = getLogger("desktop-apps");

export function desktopAppCommand(app: DesktopApp): string[] {
  return [`/usr/bin/${app.binary}`];
}

export class DesktopAppManager {
  private readonly jobs = new Map<string, "installing" | "failed">();

  constructor(
    private readonly dependencies: {
      configDir: () => string;
      installed: (app: DesktopApp) => boolean;
      install: (app: DesktopApp) => Promise<void>;
      notify: () => Promise<unknown>;
    } = {
      configDir: () => join(getDataDir(), "desktop-panel"),
      installed: (app: DesktopApp) => existsSync(desktopAppCommand(app)[0]),
      install: (app: DesktopApp) => installDesktopX11App(app.binary),
      notify: () => publishSyncInvalidation([SYNC_TAGS.assistantDesktop]),
    },
  ) {}

  list(): { id: DesktopApp["id"]; state: DesktopAppState }[] {
    return DESKTOP_APPS.map((app) => ({ id: app.id, state: this.state(app) }));
  }

  private state(app: DesktopApp): DesktopAppState {
    const job = this.jobs.get(app.id);
    if (job) {
      return job;
    }
    if (!this.dependencies.installed(app)) {
      return "available";
    }
    return existsSync(this.launcher(app)) ? "added" : "installed";
  }

  add(app: DesktopApp): void {
    if (this.jobs.get(app.id) === "installing") {
      return;
    }
    this.jobs.set(app.id, "installing");
    this.notify();
    void Promise.resolve()
      .then(async () => {
        if (!this.dependencies.installed(app)) {
          await this.dependencies.install(app);
        }
        if (!this.dependencies.installed(app)) {
          throw new Error("Desktop application is missing after installation");
        }
        const directory = this.dependencies.configDir();
        mkdirSync(join(directory, "applications"), { recursive: true });
        const icon = join(directory, `${app.binary}.png`);
        seedFile(icon, Buffer.from(app.icon, "base64"));
        seedFile(
          this.launcher(app),
          desktopEntry({
            name: app.name,
            windowClass: app.windowClass,
            icon,
            exec: desktopAppCommand(app).join(" "),
          }),
        );
        this.jobs.delete(app.id);
      })
      .catch((err: unknown) => {
        log.warn(
          { err, appId: app.id },
          "Desktop application installation failed",
        );
        this.jobs.set(app.id, "failed");
      })
      .finally(() => this.notify());
  }

  private launcher(app: DesktopApp): string {
    return join(
      this.dependencies.configDir(),
      "applications",
      `${app.binary}.desktop`,
    );
  }

  private notify(): void {
    void this.dependencies.notify().catch((err: unknown) => {
      log.warn({ err }, "Desktop application notification failed");
    });
  }
}

export const desktopAppManager = new DesktopAppManager();
