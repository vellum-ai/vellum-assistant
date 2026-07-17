import "./env-seed";
import { app, net, protocol, shell } from "electron";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  readAllowedGatewayPorts,
  resolveLocalConfigFromEnv,
  resolveLockfilePaths,
} from "@vellumai/local-mode";

import { installAbout, openAboutWindow } from "./about";
import { installAutoUpdate } from "./auto-update";
import { APP_HOST, APP_PROTOCOL, BUNDLES_DIR_NAME, VELLUMAPP_PROTOCOL } from "./app-config";
import { resolveAllowedOrigin } from "./app-origin";
import { writeCliLocator } from "./cli-installer";
import { provisionCliForWrapper } from "./cli-path-installer";
import { installCsp } from "./csp";
import { getDeviceId } from "./device-id";
import { handleSync } from "./ipc";
import { resolveAppProtocolPath } from "./app-protocol";
import { registerVellumAppProtocol } from "./vellumapp-protocol";
import { planGatewayForward } from "./gateway-forward";
import {
  fetchForwardPlanWithRetry,
  planPlatformForward,
} from "./platform-forward";
import {
  extractDeepLinkFromArgv,
  handleDeepLink,
  hasPendingDeepLinks,
  installDeepLinks,
} from "./deep-links";
import { handleBundleFile, installBundleFlow } from "./bundle-flow";
import { handleFileOpen, hasPendingFiles, installFileOpen, onFileOpen } from "./file-open";
import { installAvatarIpc } from "./avatar";
import { installCommandPaletteWindow } from "./command-palette-window";
import { installDictationOverlay } from "./dictation-overlay-window";
import { installDock } from "./dock";
import {
  installEscapeMonitor,
  setDictationRecording,
} from "./escape-monitor";
import { installDiagnosticsIpc } from "./diagnostics";
import { installFeatureFlagsIpc } from "./feature-flags";
import { installFeedbackIpc } from "./feedback";
import { installGlobalShortcuts } from "./global-shortcuts";
import { installHotkeyHelper } from "./hotkey-helper";
import { installHotkeysIpc } from "./hotkeys";
import { installImageContextMenu } from "./image-context-menu";
import { installPopoutWindows } from "./popout-window";
import { installQuickInput } from "./quick-input-window";
import { installLocalMode, resolveCliInvocation } from "./local-mode";
import { installLoginItem, installLoginItemIpc } from "./login-item";
import { installLockfileWatcher } from "./lockfile-watcher";
import { installHostProxyBridge } from "./host-proxy-router";
import "./executors/host-bash-executor"; // side-effect: registers host_bash executor
import log from "./logger";
import {
  ensureVisible as ensureMainWindowVisible,
  installMainWindow,
  toggleVisibility as toggleMainWindowVisibility,
} from "./main-window";
import { installApplicationMenu, refreshCliPathMenuState } from "./menu";
import { relocateToApplicationsFolder } from "./move-to-applications";
import { installNativeAuth } from "./native-auth";
import { installConnectivityProbe } from "./connectivity-probe";
import { installNotifications } from "./notifications";
import { installPermissionHandler } from "./permissions";
import { installPermissionsService } from "./permissions-service";
import { installPowerEvents } from "./power-events";
import { installIdentityIpc } from "./identity";
import { installConnectivityIpc, installStatusIpc } from "./status";
import { installTextInsertionIpc } from "./textInsertion";
import { installTray } from "./tray";
import { hardenedWebPreferences } from "./windows";

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
// `./session-token-store` — makes Chromium prompt for the login
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

import { initSentryMain } from "./sentry";

initSentryMain();

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
  const { platformUrl } = resolveLocalConfigFromEnv(process.env);

  protocol.handle(APP_PROTOCOL, async (request) => {
    // The renderer addresses local gateways at the same `app://` origin via
    // `/assistant/__gateway/{port}/*`. Forward those to loopback here so the
    // secure renderer never touches an insecure `http://127.0.0.1` origin
    // directly; the lockfile allowlist is the security boundary. Mirrors the
    // Vite dev-server proxy (`clients/web/vite-plugin-local-mode.ts`).
    const proxied = await forwardGatewayRequest(request, getAllowedGatewayPorts);
    if (proxied) return proxied;

    // Platform API routes (`/v1/*`, `/_allauth/*`, `/accounts/*`) forward to
    // the cloud platform so managed mode works in packaged builds. Mirrors the
    // Vite dev-server proxy (`clients/web/vite.config.ts` server.proxy entries).
    const platformProxied = await forwardPlatformRequest(request, platformUrl);
    if (platformProxied) return platformProxied;

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

/**
 * Forward a gateway data-plane request (`/assistant/__gateway/{port}/*`) to the
 * local gateway on loopback, or return `null` when the URL is not a gateway
 * request so the caller serves it as a static asset. `net.fetch` runs in the
 * main process, so the renderer only ever talks to its own secure `app://`
 * origin — main does the `http://127.0.0.1` hop. The streaming `Response` is
 * returned verbatim, preserving SSE and chunked transfers (Electron's
 * `stream: true` scheme privilege). `planGatewayForward` owns the allowlist and
 * header decisions; this wrapper is just the effect.
 */
const forwardGatewayRequest = async (
  request: GlobalRequest,
  getAllowedPorts: () => Set<number>,
): Promise<Response | null> => {
  const plan = planGatewayForward(request, getAllowedPorts);
  switch (plan.kind) {
    case "pass":
      return null;
    case "reject":
      return new Response(plan.message, { status: plan.status });
    case "forward":
      return net.fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        body: plan.hasBody ? request.body : undefined,
        // Stream the request body instead of buffering it; required by the
        // fetch spec whenever a `ReadableStream` body is supplied.
        ...(plan.hasBody ? { duplex: "half" } : {}),
        redirect: "manual",
      });
  }
};

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
  if (plan.kind === "pass") return null;
  if (plan.kind === "reject") {
    return new Response(plan.message, { status: plan.status });
  }

  // Transient net-stack failures (e.g. ERR_NETWORK_CHANGED while Wi-Fi
  // reassociates after sleep) retry in-proxy for GET/HEAD; whatever still
  // fails becomes a structured 502 the renderer can classify, never a raw
  // `net::ERR_*` body (LUM-2402).
  return fetchForwardPlanWithRetry(
    plan,
    () =>
      net.fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        body: plan.hasBody ? request.body : undefined,
        ...(plan.hasBody ? { duplex: "half" } : {}),
        redirect: "manual",
        // Auth is header-based (X-Session-Token), not cookie-based.
        // Omit credentials so stale session cookies in the main process's
        // default session store never shadow the renderer's token header.
        credentials: "omit",
      }),
    {
      onError: (err, attempt) => {
        console.error(
          `[platform-forward] net.fetch failed (attempt ${attempt + 1}) for ${plan.method} ${plan.url}:`,
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
    // Install into /Applications before any other setup. On the first packaged
    // launch from a mounted DMG (or ~/Downloads), the app silently moves itself
    // there and relaunches — the "double-click to install" half of the DMG flow.
    // Skip it when a file or deep link triggered the launch: those events are
    // buffered in-process and would be lost during the relaunch.
    if (!hasPendingFiles() && !hasPendingDeepLinks()) {
      if (await relocateToApplicationsFolder()) return;
    }

    if (!isDev) {
      registerAppProtocol();
    }
    registerVellumAppProtocol(
      path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    );
    installBundleFlow();
    onFileOpen(handleBundleFile);
    installPermissionHandler();
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
        .then((provisioned) => (provisioned ? refreshCliPathMenuState() : undefined))
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
    installPopoutWindows();
    installGlobalShortcuts();
    // Register the avatar channel before the Dock and Tray install so their
    // initial render reflects any avatar the renderer publishes during
    // bootstrap rather than briefly showing the bundled fallback mark.
    installAvatarIpc();
    installDock();
    installPowerEvents();
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
  // Cross-platform deep-link delivery: macOS routes second-launch
  // deep links via a fresh `open-url` on the primary instance (argv
  // is empty). Windows / Linux deliver the URL via argv and
  // `open-url` never fires. Always check argv here so the buffered
  // / broadcast pipeline is platform-agnostic.
  const deepLink = extractDeepLinkFromArgv(argv);
  if (deepLink) handleDeepLink(deepLink);
  // Forward .vellum file paths from second-instance argv so the
  // buffer/broadcast pipeline handles them identically to open-file.
  for (const arg of argv) {
    if (/\.vellum$/i.test(arg)) {
      handleFileOpen(arg);
    }
  }
});

app.on("web-contents-created", (_event, contents) => {
  // Electron internals + our own cleanup listeners (deep-links, power-events)
  // exceed the default 10-listener cap per WebContents, triggering a spurious
  // MaxListenersExceededWarning. Bump the limit to silence it.
  contents.setMaxListeners(20);

  // Right-click on an image → native "Copy Image" menu. Wired here so every
  // surface (main window, popouts, command palette, child popups) gets it.
  installImageContextMenu(contents);

  // Mirror renderer console output (info and up) into the main log file.
  // The packaged app has no devtools, so without this the renderer's
  // diagnostics — voice/dictation fallback decisions especially — are
  // invisible in the field; `vellum.log` is the only artifact a debugging
  // session can read.
  contents.on("console-message", (event) => {
    if (event.level === "debug") return;
    // wc id disambiguates which window a line came from — dictation partials
    // route to a single owner window, so cross-window confusion is invisible
    // without it.
    const line = `[renderer wc=${contents.id}] ${event.message}`;
    if (event.level === "error") log.error(line);
    else if (event.level === "warning") log.warn(line);
    else log.info(line);
  });

  contents.setWindowOpenHandler(({ url, disposition }) => {
    // Programmatic popups (`window.open(url, name, features)` with size
    // hints) come through as `new-window` disposition. The web app's OAuth /
    // connect flows open a blank popup synchronously during the click handler
    // (`window.open("", "_blank", "width=500,height=600")`), then navigate it
    // to the OAuth URL after the API call resolves. Chromium resolves the
    // empty string to `about:blank`, which must be allowed here so the popup
    // handle is returned to the renderer for the subsequent postMessage
    // callback chain.
    if (disposition === "new-window" && url === "about:blank") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { ...hardenedWebPreferences(), preload: undefined },
        },
      };
    }

    // Only http(s) is ever opened — file:, javascript:, custom schemes are
    // denied with no fallback.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { action: "deny" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { action: "deny" };
    }

    // Programmatic popups with a real URL also come through as `new-window`
    // disposition and are allowed as in-app child windows.
    if (disposition === "new-window") {
      // Child popups inherit the same hardened baseline as every window.
      // `preload: undefined` explicitly clears the parent's preload so
      // third-party OAuth pages don't get the Vellum bridge.
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { ...hardenedWebPreferences(), preload: undefined },
        },
      };
    }

    // Plain target=_blank link clicks → system browser.
    void shell.openExternal(url);
    return { action: "deny" };
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
