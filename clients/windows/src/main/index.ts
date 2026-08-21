import "./env-seed";

import { app, net, protocol, session, shell } from "electron";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { resolveAppProtocolPath } from "@vellumai/electron-utils/app-protocol";
import { VELLUMAPP_PROTOCOL } from "@vellumai/electron-desktop/bundle-platform";
import { getDeviceId } from "@vellumai/electron-desktop/device-id";
import {
  authorizePairedGatewayForwardPlan,
  executeGatewayForwardPlan,
  planGatewayForward,
  planPairedGatewayForward,
  type GatewayForwardFetcher,
} from "@vellumai/electron-desktop/gateway-forward";
import { getPairedGuardianAccessToken } from "@vellumai/electron-desktop/local-mode";
import { getWatchedLockfileSnapshot } from "@vellumai/electron-desktop/lockfile-watcher";
import {
  executePlatformForwardPlan,
  planPlatformForward,
} from "@vellumai/electron-desktop/platform-forward";
import {
  pairedGatewayTargetsFromLockfile,
  readAllowedGatewayPorts,
  readPairedGatewayTargets,
  resolveLocalConfigFromEnv,
  resolveLockfilePaths,
} from "@vellumai/local-mode";

import {
  APP_PROTOCOL,
  WINDOWS_RELEASE_INFO,
  usesAppProtocolRenderer,
} from "./app-config";
import { resolveAllowedOrigin } from "./app-origin.client";
import { provisionCliForCurrentUser } from "./cli-path-flow";
import { installMainFeatures } from "./features";
import { handleSync } from "./ipc.client";
import log from "./logger";
import { ensureVisible } from "./main-window";
import { installPairedGatewayRequestGuard } from "./paired-gateway-request-guard";
import { installWebContentsSecurity } from "./windows.client";

/**
 * Windows shell for the Vellum Assistant: a hardened BrowserWindow loading
 * the clients/web renderer (Vite dev server in dev, `app://` static serving
 * of `resources/web-dist` in packaged builds). Every desktop capability is a
 * module under `./features/`, composed through the capability registry once
 * the app is ready; `docs/parity-matrix.md` maps them to their macOS
 * counterparts.
 */

// Dev-only: override the package `name` (`@vellumai/windows`) so
// `app.getPath("userData")` resolves to its own directory, cleanly separate
// from other Vellum installs (including the macOS Electron shell when
// developing this package on a Mac). Packaged builds get a real
// `productName` from electron-builder. Must run before `userData` is first
// read.
if (!app.isPackaged) {
  app.setName("Vellum Electron Windows");
}

// Packaged builds all share the same package.json `name`, so Electron
// resolves `app.getPath("userData")` to the same directory for every
// environment. Append an environment suffix for non-production builds so
// dev/staging/production installs can run side-by-side; production keeps the
// original path for backwards compatibility.
const releaseChannel = WINDOWS_RELEASE_INFO.releaseChannel;
if (app.isPackaged) {
  if (releaseChannel !== "production") {
    const base = app.getPath("userData");
    app.setPath("userData", `${base}-${releaseChannel}`);
  }
}

// Single-instance lock: relaunches focus the existing window instead of
// spawning a parallel main process. The second-instance handler fires on the
// instance that holds the lock (the primary). The instance that fails to
// acquire calls app.quit() and never reaches whenReady.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// In prod, register `app://` as a "standard" + "secure" scheme so that fetch,
// service workers, and same-origin policy treat it like https://.
// Must be called before app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
  {
    scheme: VELLUMAPP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

// Serve clients/web/dist/ as static files via `app://vellum.ai/...`. Route-like
// paths (no file extension, or `.html`) fall back to index.html so React
// Router can handle client-side routes on reload; requests for missing
// static assets return 404 so a stale or partial deploy surfaces as a load
// error rather than silently serving HTML with a wrong Content-Type.
// `clients/web/vite.config.ts` sets `base: "/assistant/"`, so the built HTML
// emits asset URLs like `/assistant/assets/index.js` while the files on disk
// live directly under `rendererRoot`; the mount prefix is stripped before
// path resolution.
//
const RENDERER_MOUNT = "/assistant";

const resolveRendererRoot = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "web-dist");
  }
  // Dev source tree: clients/web/dist. Requires `bun run build` in clients/web/.
  const repoRoot = path.resolve(app.getAppPath(), "..", "..");
  return path.join(repoRoot, "clients", "web", "dist");
};

const registerAppProtocol = (): void => {
  const rendererRoot = resolveRendererRoot();
  const indexHtml = path.join(rendererRoot, "index.html");
  const lockfilePaths = resolveLockfilePaths(process.env);
  const getAllowedGatewayPorts = (): Set<number> =>
    readAllowedGatewayPorts(lockfilePaths);
  // Prefer the watcher's in-memory snapshot so paired requests never read
  // disk; the direct read covers only the window before the watcher installs.
  const getPairedGatewayTargets = (): Map<string, string> => {
    const watched = getWatchedLockfileSnapshot();
    return watched
      ? pairedGatewayTargetsFromLockfile(watched)
      : readPairedGatewayTargets(lockfilePaths);
  };

  protocol.handle(APP_PROTOCOL, async (request) => {
    // The renderer addresses local gateways at the same `app://` origin via
    // `/assistant/__gateway/{port}/*`. Forward those to loopback here so the
    // secure renderer never touches an insecure `http://127.0.0.1` origin
    // directly; the lockfile allowlist is the security boundary. Mirrors the
    // Vite dev-server proxy (`clients/web/vite-plugin-local-mode.ts`).
    const proxied = await forwardGatewayRequest(
      request,
      getAllowedGatewayPorts,
    );
    if (proxied) {
      return proxied;
    }

    // Paired remote gateways ride the same-origin path too, via
    // `/assistant/__gateway-paired/{assistantId}/*`; the WebRequest guard
    // admits only trusted app frames, and the lockfile's paired entries
    // allowlist the remote targets.
    const pairedProxied = await forwardPairedGatewayRequest(
      request,
      getPairedGatewayTargets,
    );
    if (pairedProxied) {
      return pairedProxied;
    }

    const platformProxied = await forwardPlatformRequest(
      request,
      resolvedConfig.platformUrl,
    );
    if (platformProxied) {
      return platformProxied;
    }

    const result = resolveAppProtocolPath(
      rendererRoot,
      request.url,
      RENDERER_MOUNT,
    );
    if (result.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }
    const { resolved } = result;
    if (await fileExists(resolved)) {
      return net.fetch(pathToFileURL(resolved).toString());
    }
    const ext = path.extname(resolved);
    if (ext === "" || ext === ".html") {
      return net.fetch(pathToFileURL(indexHtml).toString());
    }
    return new Response("Not Found", { status: 404 });
  });
};

const fileExists = async (candidate: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
};

// Synchronous config snapshot the preload reads at startup and exposes to the
// renderer as `window.__VELLUM_CONFIG__`.
const resolvedConfig = resolveLocalConfigFromEnv(process.env);
handleSync("vellum:config:get", () => ({
  webUrl: resolvedConfig.webUrl,
  platformUrl: resolvedConfig.platformUrl,
  disablePlatform:
    ["true", "1"].includes(
      (process.env.VELLUM_DISABLE_PLATFORM ?? "").toLowerCase(),
    ) || undefined,
  deviceId: getDeviceId(),
}));

const gatewayForwardFetcher: GatewayForwardFetcher = (url, init) =>
  net.fetch(url, init);

/**
 * Forward a gateway data-plane request (`/assistant/__gateway/{port}/*`) to
 * the local gateway on loopback, or return `null` when the URL is not a
 * gateway request. `net.fetch` runs in main, so the renderer only ever talks
 * to its own secure `app://` origin.
 */
const forwardGatewayRequest = async (
  request: GlobalRequest,
  getAllowedPorts: () => Set<number>,
): Promise<Response | null> =>
  executeGatewayForwardPlan(
    planGatewayForward(request, getAllowedPorts),
    request,
    gatewayForwardFetcher,
  );

/**
 * Forward a paired-gateway request (`/assistant/__gateway-paired/{id}/*`) to
 * the remote gateway an imported pairing recorded as its `runtimeUrl`, or
 * return `null` when the URL is not a paired-gateway request.
 */
const forwardPairedGatewayRequest = async (
  request: GlobalRequest,
  getTargets: () => Map<string, string>,
): Promise<Response | null> => {
  const plan = await authorizePairedGatewayForwardPlan(
    planPairedGatewayForward(request, getTargets),
    getPairedGuardianAccessToken,
  );
  return executeGatewayForwardPlan(plan, request, gatewayForwardFetcher);
};

const forwardPlatformRequest = async (
  request: GlobalRequest,
  platformUrl: string,
): Promise<Response | null> => {
  const plan = planPlatformForward(request, platformUrl, {
    allowedOrigin: resolveAllowedOrigin(),
  });
  const target = plan.kind === "forward" ? `${plan.method} ${plan.url}` : "";
  return executePlatformForwardPlan(
    plan,
    request,
    (url, init) => net.fetch(url, init),
    {
      onError: (error, attempt) => {
        log.error(
          `[platform-forward] net.fetch failed (attempt ${attempt + 1}) for ${target}:`,
          error,
        );
      },
    },
  );
};

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app
  .whenReady()
  .then(() => {
    log.info("[app] ready");
    if (usesAppProtocolRenderer(app.isPackaged)) {
      registerAppProtocol();
      installPairedGatewayRequestGuard();
    }
    if (app.isPackaged && process.platform === "win32") {
      try {
        const result = provisionCliForCurrentUser({
          userDataDir: app.getPath("userData"),
          resourcesDir: process.resourcesPath,
          localAppData:
            process.env.LOCALAPPDATA ??
            path.join(app.getPath("home"), "AppData", "Local"),
          releaseChannel,
          version: app.getVersion(),
        });
        if (["foreign", "shadowed"].includes(result.launcherState)) {
          log.warn(`[cli] Windows launcher is ${result.launcherState}`);
        }
      } catch (error) {
        log.error("[cli] Failed to provision the Windows CLI:", error);
      }
    }
    installMainFeatures();
  })
  .catch((err: unknown) => {
    log.error("[app] whenReady setup failed:", err);
  });

app.on("second-instance", () => {
  ensureVisible();
});

app.on("window-all-closed", () => {
  // Keep the notification-area tray available to reopen the window.
});

app.on("web-contents-created", (_event, contents) => {
  installWebContentsSecurity(contents, {
    cookies: () => session.defaultSession.cookies,
    logger: log,
    openExternal: (url) => shell.openExternal(url),
  });
});
