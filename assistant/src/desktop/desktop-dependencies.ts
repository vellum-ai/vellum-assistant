import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import { writeCombinedCABundle } from "../util/ca-bundle.js";
import { terminateProcessTree } from "../util/host-process.js";
import { getLogger } from "../util/logger.js";
import { getExternalDir } from "../util/platform.js";
import desktopPackages from "./desktop-packages.json" with { type: "json" };

const log = getLogger("desktop-dependencies");
const WEZTERM_VERSION = desktopPackages.wezterm.version;
const WEZTERM_PACKAGES = desktopPackages.wezterm.packages;
const CHROME_VERSION = desktopPackages.chrome.version;
const CHROME_PACKAGES = desktopPackages.chrome.packages;
const BAKED_CHROME_PATH = "/opt/google/chrome/chrome";

const DESKTOP_BINARIES = {
  xServer: ["Xtigervnc"],
  windowManager: ["openbox"],
  python: ["python3"],
  compositor: ["xcompmgr"],
  panel: ["plank"],
  sessionBus: ["dbus-daemon"],
  clipboard: ["tigervncconfig", "vncconfig"],
  terminal: ["wezterm"],
  fileManager: ["thunar"],
  wallpaper: ["feh"],
  input: ["xdotool"],
  capture: ["scrot"],
} as const;

const DESKTOP_PACKAGES = desktopPackages.packages;

export type DesktopSetupStatus = {
  state: "required" | "installing" | "ready" | "failed" | "unsupported";
  stage?: "packages" | "chrome" | "checking";
};

export function desktopChromePath(exists = existsSync): string {
  if (exists(BAKED_CHROME_PATH)) {
    return BAKED_CHROME_PATH;
  }
  return join(
    getExternalDir(),
    "desktop",
    `chrome-${CHROME_VERSION}`,
    "opt/google/chrome/chrome",
  );
}

export function resolveDesktopBinaries(
  which: (name: string) => string | null = Bun.which,
) {
  const resolved = {} as Record<keyof typeof DESKTOP_BINARIES, string>;
  for (const [role, names] of Object.entries(DESKTOP_BINARIES)) {
    const path = names.map((name) => which(name)).find(Boolean);
    if (!path) {
      throw new Error(`Desktop component is missing: ${names[0]}`);
    }
    resolved[role as keyof typeof DESKTOP_BINARIES] = path;
  }
  return resolved;
}

export function desktopDependenciesReady(
  which: (name: string) => string | null = Bun.which,
  exists = existsSync,
): boolean {
  try {
    resolveDesktopBinaries(which);
    const chrome = desktopChromePath(exists);
    return (
      exists(chrome) &&
      (chrome === BAKED_CHROME_PATH || exists(chrome + ".ready")) &&
      exists("/usr/games/gnome-mines") &&
      exists("/usr/share/dbus-1/services/org.gtk.vfs.Daemon.service") &&
      exists(
        "/usr/share/dbus-1/services/org.xfce.Tumbler.Thumbnailer1.service",
      ) &&
      exists("/usr/share/fonts/X11/misc/fonts.dir") &&
      exists("/usr/share/dbus-1/services/org.ayatana.bamf.service") &&
      exists("/usr/share/dbus-1/services/org.a11y.Bus.service") &&
      exists("/usr/lib/python3/dist-packages/dbus/__init__.py")
    );
  } catch {
    return false;
  }
}

export class DesktopDependencyInstaller {
  private installing: Promise<void> | null = null;
  private status: DesktopSetupStatus | null = null;

  constructor(
    private readonly dependencies: {
      supported: () => boolean;
      ready: () => boolean;
      install: (
        onStage: (stage: NonNullable<DesktopSetupStatus["stage"]>) => void,
      ) => Promise<void>;
      notify: () => Promise<unknown>;
    } = {
      supported: () =>
        process.platform === "linux" &&
        process.arch in CHROME_PACKAGES &&
        process.getuid?.() === 0,
      ready: desktopDependenciesReady,
      install: installDesktopDependencies,
      notify: () => publishSyncInvalidation([SYNC_TAGS.assistantDesktop]),
    },
  ) {}

  getStatus(): DesktopSetupStatus {
    if (this.installing) {
      return this.status!;
    }
    if (!this.dependencies.supported()) {
      return { state: "unsupported" };
    }
    if (this.status?.state === "failed") {
      return this.status;
    }
    return { state: this.dependencies.ready() ? "ready" : "required" };
  }

  start(): DesktopSetupStatus {
    const status = this.getStatus();
    if (
      status.state === "ready" ||
      status.state === "installing" ||
      status.state === "unsupported"
    ) {
      return status;
    }
    this.status = { state: "installing", stage: "packages" };
    this.installing = Promise.resolve()
      .then(async () => {
        await this.dependencies.install((stage) =>
          this.update({ state: "installing", stage }),
        );
        if (!this.dependencies.ready()) {
          throw new Error("Desktop components are missing after installation");
        }
        this.status = { state: "ready" };
      })
      .catch((err: unknown) => {
        log.warn({ err }, "Desktop installation failed");
        this.status = { state: "failed", stage: this.status?.stage };
      })
      .finally(() => {
        this.installing = null;
        this.update(this.status!);
      });
    this.update(this.status);
    return this.status;
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.start();
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        void Promise.resolve(this.installing).then(() => resolve(), reject);
      });
      signal?.throwIfAborted();
      const status = this.getStatus();
      if (status.state === "unsupported") {
        throw new Error(
          "Virtual desktop installation is unsupported on this assistant.",
        );
      }
      if (status.state !== "ready") {
        throw new Error(
          `Virtual desktop setup failed during ${status.stage ?? "installation"}. Open the Virtual desktop panel to retry. Do not launch Chrome manually.`,
        );
      }
    } finally {
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  private update(status: DesktopSetupStatus): void {
    this.status = status;
    void this.dependencies.notify().catch((err: unknown) => {
      log.warn({ err }, "Desktop setup notification failed");
    });
  }
}

async function run(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, {
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/root",
      DEBIAN_FRONTEND: "noninteractive",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    detached: true,
  });
  const timeout = setTimeout(() => terminateProcessTree(proc), 10 * 60_000);
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      output = (output + new TextDecoder().decode(chunk)).slice(-8_000);
    }
  };
  const [code] = await Promise.all([
    proc.exited,
    drain(proc.stdout),
    drain(proc.stderr),
  ]).finally(() => clearTimeout(timeout));
  if (code !== 0) {
    throw new Error(`Desktop installer exited with ${code}: ${output}`);
  }
}

async function installDesktopDependencies(
  onStage: (stage: NonNullable<DesktopSetupStatus["stage"]>) => void,
): Promise<void> {
  const extraCA = process.env.NODE_EXTRA_CA_CERTS;
  if (!extraCA) {
    return installDesktopComponents(onStage);
  }
  const caDir = await mkdtemp(join(tmpdir(), "desktop-ca-"));
  try {
    const caBundle = join(caDir, "ca.pem");
    await writeCombinedCABundle(
      "/etc/ssl/certs/ca-certificates.crt",
      extraCA,
      caBundle,
    );
    // apt's unprivileged downloader must be able to read the public CAs.
    await chmod(caBundle, 0o644);
    await chmod(caDir, 0o755);
    await installDesktopComponents(onStage, caBundle);
  } finally {
    await rm(caDir, { recursive: true, force: true });
  }
}

async function installDesktopComponents(
  onStage: (stage: NonNullable<DesktopSetupStatus["stage"]>) => void,
  caBundle?: string,
): Promise<void> {
  const chrome = CHROME_PACKAGES[process.arch as keyof typeof CHROME_PACKAGES];
  const apt = [
    "/usr/bin/apt-get",
    ...(caBundle ? ["-o", `Acquire::https::CaInfo=${caBundle}`] : []),
  ];
  const chromePath = desktopChromePath();
  if (chromePath !== BAKED_CHROME_PATH) {
    await rm(chromePath + ".ready", { force: true });
  }
  // Desktop binaries, X assets and the loader share the image root.
  await run([...apt, "update"]);
  const terminal =
    WEZTERM_PACKAGES[process.arch as keyof typeof WEZTERM_PACKAGES];
  const terminalDownloadDir = await mkdtemp(
    join(tmpdir(), "desktop-terminal-"),
  );
  try {
    const deb = join(terminalDownloadDir, "wezterm.deb");
    await downloadDesktopPackage(
      `https://github.com/wezterm/wezterm/releases/download/${WEZTERM_VERSION}/wezterm-${WEZTERM_VERSION}.${terminal.suffix}`,
      deb,
      terminal.sha256,
      caBundle,
    );
    await chmod(terminalDownloadDir, 0o755);
    await chmod(deb, 0o644);
    await run([
      ...apt,
      "install",
      "-y",
      "--no-install-recommends",
      "--no-upgrade",
      "--no-remove",
      "-o",
      "DPkg::Lock::Timeout=120",
      ...DESKTOP_PACKAGES,
      deb,
    ]);
  } finally {
    await rm(terminalDownloadDir, { recursive: true, force: true });
  }
  onStage("chrome");
  if (!existsSync(desktopChromePath())) {
    const downloadDir = await mkdtemp(join(tmpdir(), "desktop-chrome-"));
    const installRoot = join(getExternalDir(), "desktop");
    await mkdir(installRoot, { recursive: true });
    const staging = await mkdtemp(join(installRoot, ".install-"));
    try {
      const deb = join(downloadDir, "chrome.deb");
      await downloadDesktopPackage(
        `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_${chrome.arch}.deb`,
        deb,
        chrome.sha256,
        caBundle,
      );
      await run(["dpkg-deb", "--extract", deb, staging]);
      await rename(staging, join(installRoot, `chrome-${CHROME_VERSION}`));
    } finally {
      await Promise.all([
        rm(downloadDir, { recursive: true, force: true }),
        rm(staging, { recursive: true, force: true }),
      ]);
    }
  }
  onStage("checking");
  await run([resolveDesktopBinaries().terminal, "--version"]);
  await run([desktopChromePath(), "--version"]);
  if (chromePath !== BAKED_CHROME_PATH) {
    await writeFile(chromePath + ".ready", "");
  }
}

async function downloadDesktopPackage(
  url: string,
  destination: string,
  sha256: string,
  caBundle?: string,
): Promise<void> {
  await run([
    "curl",
    ...(caBundle ? ["--cacert", caBundle] : []),
    "--fail",
    "--location",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--retry",
    "2",
    "--max-time",
    "300",
    "--output",
    destination,
    url,
  ]);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(destination)) {
    hash.update(chunk);
  }
  if (hash.digest("hex") !== sha256) {
    throw new Error("Desktop package download checksum mismatch");
  }
}

export const desktopDependencyInstaller = new DesktopDependencyInstaller();
