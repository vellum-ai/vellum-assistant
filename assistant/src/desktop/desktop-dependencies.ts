import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import { writeCombinedCABundle } from "../util/ca-bundle.js";
import { terminateProcessTree } from "../util/host-process.js";
import { getLogger } from "../util/logger.js";
import { getExternalDir } from "../util/platform.js";

const log = getLogger("desktop-dependencies");
const WEZTERM_VERSION = "20240203-110809-5046fc22";
const WEZTERM_PACKAGES = {
  x64: {
    suffix: "Debian12.deb",
    sha256: "d3a5c97093fbc0a87e8f9616e44efc4c9503cfc495fd1cfe4ffeff88578d15f8",
  },
  arm64: {
    suffix: "Debian12.arm64.deb",
    sha256: "351f8791c6e9561d687afa63834a2132de84800dad6e7c3d035cc6518d6c3744",
  },
} as const;
const CHROME_VERSION = "153.0.8010.36-1";
const CHROME_PACKAGES = {
  x64: {
    arch: "amd64",
    sha256: "9bb44e33031c2f2857cf36b4343051a12f93058e4b781e3c76313df87f6c8d32",
  },
  arm64: {
    arch: "arm64",
    sha256: "1fcf6ec51a9d52e26ff1ad807225f725be55069ad2b68c5d69361a2746665188",
  },
} as const;

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

const DESKTOP_PACKAGES = [
  "adwaita-icon-theme",
  "at-spi2-core",
  "dbus-x11",
  "feh",
  "gnome-mines",
  "gvfs",
  "thunar",
  "tumbler",
  "openbox",
  "python3",
  "python3-dbus",
  "tigervnc-standalone-server",
  "tigervnc-common",
  "plank",
  "bamfdaemon",
  "dbus-daemon",
  "xauth",
  "xcompmgr",
  "xfonts-base",
  // Preserved Openbox menus and shortcuts can invoke xterm directly.
  "xterm",
  "xdotool",
  "scrot",
  "fonts-liberation",
  "libgtk-3-0",
  "libegl1",
  "libgl1-mesa-dri",
  "libvulkan1",
  "libcurl4",
];

export type DesktopSetupStatus = {
  state: "required" | "installing" | "ready" | "failed" | "unsupported";
  stage?: "packages" | "chrome" | "checking";
};

export function desktopChromePath(): string {
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
      ready: () => {
        try {
          resolveDesktopBinaries();
          return (
            existsSync(desktopChromePath() + ".ready") &&
            existsSync(desktopChromePath()) &&
            existsSync("/usr/games/gnome-mines") &&
            existsSync(
              "/usr/share/dbus-1/services/org.gtk.vfs.Daemon.service",
            ) &&
            existsSync(
              "/usr/share/dbus-1/services/org.xfce.Tumbler.Thumbnailer1.service",
            ) &&
            existsSync("/usr/share/fonts/X11/misc/fonts.dir") &&
            existsSync("/usr/share/dbus-1/services/org.ayatana.bamf.service") &&
            existsSync("/usr/share/dbus-1/services/org.a11y.Bus.service") &&
            existsSync("/usr/lib/python3/dist-packages/dbus/__init__.py")
          );
        } catch {
          return false;
        }
      },
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

async function run(command: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
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

async function withDesktopCA(
  action: (caBundle?: string) => Promise<void>,
): Promise<void> {
  const extraCA = process.env.NODE_EXTRA_CA_CERTS;
  if (!extraCA) {
    return action();
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
    await action(caBundle);
  } finally {
    await rm(caDir, { recursive: true, force: true });
  }
}

async function installDesktopDependencies(
  onStage: (stage: NonNullable<DesktopSetupStatus["stage"]>) => void,
): Promise<void> {
  await withDesktopPackages((apt, caBundle) =>
    installDesktopComponents(onStage, apt, caBundle),
  );
}

let packageInstallation: Promise<void> = Promise.resolve();

function withDesktopPackages(
  action: (apt: string[], caBundle?: string) => Promise<void>,
): Promise<void> {
  const installation = packageInstallation.then(() =>
    withDesktopCA(async (caBundle) => {
      const apt = [
        "/usr/bin/apt-get",
        ...(caBundle ? ["-o", `Acquire::https::CaInfo=${caBundle}`] : []),
      ];
      await run([...apt, "update"]);
      await action(apt, caBundle);
    }),
  );
  packageInstallation = installation.catch(() => {});
  return installation;
}

export function installDesktopX11App(binary: "xcalc" | "xedit"): Promise<void> {
  return withDesktopPackages(async (apt) => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-app-"));
    const stagedBinary = `/usr/bin/.vellum-${binary}.tmp`;
    try {
      await run([...apt, "download", "x11-apps"], directory);
      const deb = (await readdir(directory)).find((file) =>
        file.endsWith(".deb"),
      );
      if (!deb) {
        throw new Error("Desktop app download is missing");
      }
      const extracted = join(directory, "extracted");
      await run(["dpkg-deb", "--extract", join(directory, deb), extracted]);
      // Retain only the MIT/BSD app and its resources, excluding bundled GPL utilities.
      const appClass = binary === "xcalc" ? "XCalc" : "Xedit";
      for (const suffix of ["", "-color"]) {
        await copyFile(
          join(extracted, "etc/X11/app-defaults", appClass + suffix),
          `/etc/X11/app-defaults/${appClass}${suffix}`,
        );
      }
      if (binary === "xedit") {
        await cp(join(extracted, "usr/lib/X11/xedit"), "/usr/lib/X11/xedit", {
          recursive: true,
        });
      }
      await mkdir("/usr/share/doc/vellum-desktop-apps", { recursive: true });
      await copyFile(
        join(extracted, "usr/share/doc/x11-apps/copyright"),
        "/usr/share/doc/vellum-desktop-apps/copyright",
      );
      await copyFile(join(extracted, "usr/bin", binary), stagedBinary);
      await chmod(stagedBinary, 0o755);
      await rename(stagedBinary, `/usr/bin/${binary}`);
    } finally {
      await rm(stagedBinary, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function installDesktopComponents(
  onStage: (stage: NonNullable<DesktopSetupStatus["stage"]>) => void,
  apt: string[],
  caBundle?: string,
): Promise<void> {
  const chrome = CHROME_PACKAGES[process.arch as keyof typeof CHROME_PACKAGES];
  await rm(desktopChromePath() + ".ready", { force: true });
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
  await writeFile(desktopChromePath() + ".ready", "");
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
