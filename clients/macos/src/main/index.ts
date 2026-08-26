import "./env-seed";
import { app, net, protocol, session, shell } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { installCsp } from "@vellumai/electron-desktop/csp";
import { installCommandPaletteWindow } from "@vellumai/electron-desktop/command-palette-window";
import { getDeviceId } from "@vellumai/electron-desktop/device-id";
import { installDictationOverlay } from "@vellumai/electron-desktop/dictation-overlay-window";
import {
  forwardGatewayRequest,
  forwardPairedGatewayRequest,
  type GatewayForwardFetcher,
} from "@vellumai/electron-desktop/gateway-forward";
import { installPermissionHandler } from "@vellumai/electron-desktop/permissions";
import { installPairedGatewayRequestGuard } from "@vellumai/electron-desktop/paired-gateway-request-guard";
import {
  executePlatformForwardPlan,
  planPlatformForward,
} from "@vellumai/electron-desktop/platform-forward";
import { installPopoutWindows } from "@vellumai/electron-desktop/popout-window";
import { installQuickInput } from "@vellumai/electron-desktop/quick-input-window";
import { planAppProtocolAssetRequest } from "@vellumai/electron-utils/app-protocol";
import {
  pairedGatewayTargetsFromLockfile,
  readAllowedGatewayPorts,
  readPairedGatewayTargets,
  resolveLocalConfigFromEnv,
  resolveLockfilePaths,
} from "@vellumai/local-mode";

import { installAbout, openAboutWindow } from "./about.client";
import { installAutoUpdate } from "./auto-update.client";
import {
  BUNDLES_DIR_NAME,
  VELLUMAPP_PROTOCOL,
} from "@vellumai/electron-desktop/bundle-platform";
import { registerVellumAppProtocol } from "@vellumai/electron-desktop/vellumapp-protocol";
import { APP_HOST, APP_PROTOCOL } from "./app-config";
import { resolveAllowedOrigin } from "./app-origin";
import { writeCliLocator } from "./cli-installer";
import { provisionCliForWrapper } from "./cli-path-installer";
import { handle, handleSync, on } from "./ipc";
import { hasPendingDeepLinks, installDeepLinks } from "./deep-links.client";
import { handleBundleFile, installMacBundleWorkflow } from "./bundles";
import {
  handleFileOpenArgv,
  hasPendingFiles,
  installFileOpen,
  onFileOpen,
} from "./file-open.client";
import { installAvatarIpc } from "@vellumai/electron-desktop/avatar";
import { installConnectivityProbe } from "@vellumai/electron-desktop/connectivity-probe";
import { installDownloads } from "@vellumai/electron-desktop/downloads";
import { installIdentityIpc } from "@vellumai/electron-desktop/identity";
import {
  configureNotifications,
  installNotifications,
} from "@vellumai/electron-desktop/notifications";
import { installPowerEvents } from "@vellumai/electron-desktop/power-events";
import { configurePresenceRuntime } from "@vellumai/electron-desktop/presence-runtime";
import {
  installConnectivityIpc,
  installStatusIpc,
} from "@vellumai/electron-desktop/status";
import "./auxiliary-windows.client";
import { installDock } from "./dock";
import { installShare } from "./share";
import {
  installEscapeMonitor,
  setDictationRecording,
} from "./escape-monitor";
import {
  initSentryMain,
  installDiagnosticsIpc,
  installFeatureFlagsIpc,
  installFeedbackIpc,
} from "./desktop-diagnostics";
import { installGlobalShortcuts } from "./global-shortcuts.client";
import { installHotkeyHelper } from "./hotkey-helper";
import { installHotkeysIpc } from "./hotkeys.client";
import { installImageContextMenu } from "@vellumai/electron-desktop/image-context-menu";
import { installTextContextMenu } from "@vellumai/electron-desktop/text-context-menu";
import {
  getPairedGuardianAccessToken,
  installLocalMode,
  resolveCliInvocation,
} from "./local-mode.client";
import { installLoginItem, installLoginItemIpc } from "./login-item.client";
import {
  getWatchedLockfileSnapshot,
  installLockfileWatcher,
} from "./lockfile-watcher.client";
import { installHostProxyBridge } from "./host-proxy-adapter";
import log from "./logger";
import {
  ensureVisible as ensureMainWindowVisible,
  installMainWindow,
  toggleVisibility as toggleMainWindowVisibility,
} from "./main-window";
import { installApplicationMenu, refreshCliPathMenuState } from "./menu";
import {
  promptToRelocateIfStranded,
  relocateToApplicationsFolder,
} from "./move-to-applications";
import { markRelocationSkipped } from "./install-location";
import { installNativeAuth } from "./native-auth.client";
import { installPermissionsService } from "./permissions-service";
import {
  installCompanionWindow,
  syncCompanionSurface,
} from "./companion-window";
import { installTextInsertionIpc } from "./textInsertion";
import { installTray } from "./tray.client";
import { installWebContentsSecurity } from "./windows";

// Dev-only: override the workspace `name` (`@vellumai/macos`) so the
// menu bar's first submenu reads "Vellum Electron", and — more
// importantly — so `app.getPath("userData")` resolves to
// `~/Library/Application Support/Vellum Electron/`, cleanly separate
// from the Swift `Vellum.app` / `Vellum Local.app` / `Vellum Dev.app`
// installs the developer may also be running.
//
// Caveat: `app.setName()` does NOT change the Dock / Cmd-Tab label —
// those come from the running binary's `CFBundleName`. In dev the binary
// is `node_modules/electron/dist/Electron.app`, whose `CFBundleName` is
// stamped to "Vellum Electron" by `scripts/prepare-electron-dev-app.ts`
// (which also busts the macOS Dock display-name cache so the relabel
// actually surfaces instead of the stale stock "Electron"). The userData
// split is what prevents collision with Swift installs. Packaged builds
// get a real `productName` from electron-builder, which writes
// `CFBundleName`, so Dock / Cmd-Tab pick up the real name there too. The
// per-assistant name (e.g. "Aria") can't ride the Dock tile — it isn't
// known at launch and `CFBundleName` is read once — so it drives the
// window title, the menu-bar tray, and the About panel instead (see
// `./identity`).
//
// Gated on `!app.isPackaged` so a packaged build keeps its
// electron-builder-derived `CFBundleName` instead of being overridden
// at runtime. Must run before `app.getPath("userData")` is first read;
// the electron-store instance in `./settings` is constructed lazily on
// first IPC call, so this timing holds as long as `app.setName` runs
// before `app.whenReady`.
if (!app.isPackaged) {
  app.setName("Vellum Electron");
}
const isDev = !app.isPackaged;

// Dev-only: skip the real macOS Keychain for Chromium's `os_crypt` /
// Electron `safeStorage`. Without this, the first `safeStorage` call —
// e.g. persisting the session token after sign-in via
// `./session-token-store.client` makes Chromium prompt for the login
// keychain password ("Vellum Electron Safe Storage"). Denying that
// prompt surfaces as `keychain_password_mac.mm ... userCanceledErr
// (-128)` and silently drops token persistence. `--use-mock-keychain`
// routes os_crypt to an in-process mock backend: `safeStorage` stays
// available and encrypt/decrypt still work (so the token persists
// across dev restarts), but nothing ever touches the real keychain, so
// there is no prompt. Dev-encrypted blobs are not readable by a real
// keychain build, which is fine for local dev — and a `session.enc`
// left over from a previous real-keychain run just fails to decrypt and
// falls back to signed-out (see `getSessionToken`), self-healing on the
// next sign-in. Must be appended before `app` is ready; this module
// runs synchronously at startup, well before `app.whenReady`. Gated on
// dev so packaged builds keep real keychain encryption at rest.
if (isDev) {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// Packaged builds all share the same package.json `name` (`@vellumai/macos`),
// so Electron resolves `app.getPath("userData")` to the same directory for
// every environment. This causes `requestSingleInstanceLock()` collisions
// when multiple environment builds (dev, staging, production) run side-by-side.
// Append an environment suffix for non-production builds; production keeps the
// original path for backwards compatibility.
declare const __VELLUM_ENVIRONMENT__: string;
if (app.isPackaged) {
  const env =
    typeof __VELLUM_ENVIRONMENT__ === "string"
      ? __VELLUM_ENVIRONMENT__
      : "production";
  if (env !== "production") {
    const base = app.getPath("userData");
    app.setPath("userData", `${base}-${env}`);
  }
}

initSentryMain();

// Single-instance lock: relaunches focus the existing window instead of
// spawning a parallel main process. The second-instance handler fires on the
// instance that holds the lock (the primary).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
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

// Deep-link plumbing — register at module top-level so the
// `will-finish-launching` subscription captures URLs delivered AT
// launch (the OS opens the app via a `vellum://` click → `open-url`
// can fire before `whenReady`). Registering in `whenReady` misses
// the launching URL — the #1 deep-link bug in Electron apps.
installDeepLinks();
installFileOpen();

// Serve clients/web/dist/ as static files via `app://vellum.ai/...`. Route-like
// paths (no file extension, or `.html`) fall back to index.html so React
// Router can handle client-side routes on reload / deep-link; requests for
// missing static assets return 404 so a stale or partial deploy surfaces as
// a load error rather than silently serving HTML with a wrong Content-Type.
// Reference: https://www.electronjs.org/docs/latest/api/protocol#protocolhandlescheme-handler
// `clients/web/vite.config.ts` sets `base: "/assistant/"`, so the built
// HTML emits asset URLs like `/assistant/assets/index.js`. The
// renderer files on disk live directly under `rendererRoot`, NOT
// under `rendererRoot/assistant/`. Pass the mount as a separate
// parameter so the protocol handler strips it before path resolution.
const RENDERER_MOUNT = "/assistant";

const resolveRendererRoot = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "web-dist");
  }
  // Dev source tree: clients/web/dist — requires `bun run build` in clients/web/.
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
  const { platformUrl } = resolveLocalConfigFromEnv(process.env);

  protocol.handle(APP_PROTOCOL, async (request) => {
    // The renderer addresses local gateways at the same `app://` origin via
    // `/assistant/__gateway/{port}/*`. Forward those to loopback here so the
    // secure renderer never touches an insecure `http://127.0.0.1` origin
    // directly; the lockfile allowlist is the security boundary. Mirrors the
    // Vite dev-server proxy (`clients/web/vite-plugin-local-mode.ts`).
    const proxied = await forwardGatewayRequest(
      request,
      getAllowedGatewayPorts,
      gatewayForwardFetcher,
    );
    if (proxied) return proxied;

    // Paired remote gateways ride the same-origin path too, via
    // `/assistant/__gateway-paired/{assistantId}/*`: the packaged app's CSP
    // pins `connect-src` to Vellum origins, so the renderer cannot reach a
    // paired gateway directly. The WebRequest guard admits only trusted app
    // frames, and the lockfile's paired entries allowlist the remote targets.
    const pairedProxied = await forwardPairedGatewayRequest(
      request,
      getPairedGatewayTargets,
      getPairedGuardianAccessToken,
      gatewayForwardFetcher,
    );
    if (pairedProxied) {
      return pairedProxied;
    }

    // Platform API routes (`/v1/*`, `/_allauth/*`, `/accounts/*`) forward to
    // the cloud platform so managed mode works in packaged builds. Mirrors the
    // Vite dev-server proxy (`clients/web/vite.config.ts` server.proxy entries).
    const platformProxied = await forwardPlatformRequest(request, platformUrl);
    if (platformProxied) return platformProxied;

    const asset = await planAppProtocolAssetRequest({
      rendererRoot,
      indexHtml,
      requestUrl: request.url,
      mountPrefix: RENDERER_MOUNT,
      allowedOrigin: { protocol: `${APP_PROTOCOL}:`, host: APP_HOST },
    });
    if (asset.kind === "forbidden") {
      return new Response("Forbidden", { status: 403 });
    }
    if (asset.kind === "fetch") {
      return net.fetch(pathToFileURL(asset.path).toString());
    }
    return new Response("Not Found", { status: 404 });
  });
};

const gatewayForwardFetcher: GatewayForwardFetcher = (url, init) =>
  net.fetch(url, init);

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

/**
 * Forward a platform API request (`/v1/*`, `/_allauth/*`, `/accounts/*`) to
 * the cloud platform, or return `null` for non-platform paths. Mirrors the
 * gateway forward: `net.fetch` runs in main so the renderer stays same-origin.
 */
const forwardPlatformRequest = async (
  request: GlobalRequest,
  platformUrl: string,
): Promise<Response | null> => {
  const plan = planPlatformForward(request, platformUrl, {
    allowedOrigin: resolveAllowedOrigin(),
  });
  const target = plan.kind === "forward" ? `${plan.method} ${plan.url}` : "";
  // Transient net-stack failures (e.g. ERR_NETWORK_CHANGED while Wi-Fi
  // reassociates after sleep) retry in-proxy for GET/HEAD; whatever still
  // fails becomes a structured 502 the renderer can classify, never a raw
  // `net::ERR_*` body (LUM-2402).
  return executePlatformForwardPlan(
    plan,
    request,
    (url, init) => net.fetch(url, init),
    {
      onError: (err, attempt) => {
        console.error(
          `[platform-forward] net.fetch failed (attempt ${attempt + 1}) for ${target}:`,
          err,
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
  .then(async () => {
    // The instance that lost the single-instance lock is already quitting.
    // `app.quit()` requests a shutdown rather than halting the module, and a
    // `ready` that is already queued still fires, so the losing instance gates
    // its own setup here. Electron's documented single-instance example puts
    // every `whenReady` side effect behind this same branch.
    // https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata
    if (!gotSingleInstanceLock) {
      return;
    }

    configurePresenceRuntime({ ipc: { handle, on }, logger: log });

    // Install into /Applications before any other setup. On the first packaged
    // launch from a mounted DMG (or ~/Downloads), the app silently moves itself
    // there and relaunches — the "double-click to install" half of the DMG flow.
    // Skip it when a file or deep link triggered the launch: those events are
    // buffered in-process and would be lost during the relaunch.
    if (hasPendingFiles() || hasPendingDeepLinks()) {
      markRelocationSkipped();
    } else if (await relocateToApplicationsFolder()) {
      return;
    }

    if (!isDev) {
      registerAppProtocol();
      installPairedGatewayRequestGuard({
        appOrigin: { protocol: `${APP_PROTOCOL}:`, host: APP_HOST },
        resolveAllowedOrigin,
      });
    }
    registerVellumAppProtocol(
      path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    );
    installMacBundleWorkflow();
    onFileOpen(handleBundleFile);
    installPermissionHandler(resolveAllowedOrigin);
    installCsp();
    installHotkeysIpc();
    installFeatureFlagsIpc();
    installDiagnosticsIpc();
    installLocalMode();
    // Refresh the PATH-wrapper locator every launch so app moves and
    // version bumps self-heal even if no CLI invocation happens this session.
    if (app.isPackaged) {
      writeCliLocator();
      // Wrapper users also get the pinned CLI provisioned eagerly so a
      // version bump rewrites the locator now (and prunes old versions)
      // rather than after the next in-app CLI action.
      void provisionCliForWrapper()
        .then((provisioned) =>
          provisioned ? refreshCliPathMenuState() : undefined,
        )
        .catch((err: unknown) => {
          log.error("[app] startup CLI provisioning failed:", err);
        });
    }
    installLoginItem();
    installLoginItemIpc();
    installHotkeyHelper();
    installPermissionsService();
    // Register the identity (assistant name) channel before About, the Tray,
    // and the main window install so their initial render reflects any name
    // the renderer publishes during bootstrap.
    installIdentityIpc();
    installAbout();
    installAutoUpdate();
    installFeedbackIpc();
    installTextInsertionIpc();
    installCommandPaletteWindow();
    installApplicationMenu();
    installQuickInput();
    installDictationOverlay({ onRecordingLifecycle: setDictationRecording });
    installCompanionWindow();
    installPopoutWindows();
    installGlobalShortcuts();
    // Register the avatar channel before the Dock and Tray install so their
    // initial render reflects any avatar the renderer publishes during
    // bootstrap rather than briefly showing the bundled fallback mark.
    installAvatarIpc();
    installDock();
    installShare();
    // Files renderer downloads into ~/Downloads instead of prompting a Save
    // panel. Distinct from `installShare`, which is the "send elsewhere" intent.
    installDownloads({ handle });
    installPowerEvents();
    configureNotifications({
      ipc: { handle },
      ensureVisible: ensureMainWindowVisible,
      logger: log,
    });
    installNotifications();
    // Register the status channel before the tray installs so the tray's
    // initial render reflects any status the renderer publishes during
    // bootstrap rather than briefly showing the default idle dot.
    installStatusIpc();
    installEscapeMonitor();
    const lockfilePaths = resolveLockfilePaths(process.env);
    const runProbe = installConnectivityProbe(lockfilePaths);
    installConnectivityIpc(runProbe);
    // Start watching the lockfile before the tray installs so the assistant
    // switcher submenu has data on its first right-click.
    const teardownLockfileWatcher = installLockfileWatcher();
    app.on("before-quit", teardownLockfileWatcher);
    const teardownHostProxy = installHostProxyBridge(resolveCliInvocation);
    app.on("before-quit", teardownHostProxy);
    installTray({
      toggleMainWindow: toggleMainWindowVisibility,
      ensureMainWindow: ensureMainWindowVisible,
      openAbout: openAboutWindow,
    });
    installNativeAuth();
    installMainWindow();

    // After the main window, so the surface opens over a running app rather
    // than being the first thing on screen at launch. Present from here on,
    // unless the user has hidden it from the tray: the app being frontmost is
    // not one of its states.
    //
    // A launch that has nobody signed in yet leaves it closed, and the window
    // that opens it later is the app's own, once it has an assistant to
    // publish.
    syncCompanionSurface();

    // Runs after the main window so the recovery dialog has a window to sit in
    // front of, and so a user who declines lands on a working app rather than
    // an empty screen. A packaged app outside /Applications cannot update, and
    // the relocation at the head of this block is the only thing that would
    // have fixed it.
    void promptToRelocateIfStranded().catch((err: unknown) => {
      log.error("[app] relocation prompt failed:", err);
    });

    // Dock-icon click / Cmd-Tab re-activation: bring the main window
    // back to front, recreating it if it was previously closed. The
    // primitive handles both the destroyed-window and the
    // visible-but-not-focused cases, so we don't need to branch here
    // on auxiliary window counts the way the old check did.
    app.on("activate", () => {
      ensureMainWindowVisible();
    });
  })
  .catch((err: unknown) => {
    log.error("[app] whenReady setup failed:", err);
  });

app.on("second-instance", (_event, argv) => {
  // Behavior change vs prior code path: previously a second-instance
  // launch was a no-op when the main window had been destroyed. Now
  // we recreate so the user always sees a window in response to
  // re-launching the app.
  ensureMainWindowVisible();
  handleFileOpenArgv(argv);
});

app.on("web-contents-created", (_event, contents) => {
  // Electron internals + our own cleanup listeners (deep-links, power-events)
  // exceed the default 10-listener cap per WebContents, triggering a spurious
  // MaxListenersExceededWarning. Bump the limit to silence it.
  contents.setMaxListeners(20);

  // Right-click on an image → native "Copy Image" menu. Wired here so every
  // surface (main window, popouts, command palette, child popups) gets it.
  installImageContextMenu(contents);
  installTextContextMenu(contents);

  installWebContentsSecurity(contents, {
    cookies: () => session.defaultSession.cookies,
    logger: log,
    openExternal: (url) => shell.openExternal(url),
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
