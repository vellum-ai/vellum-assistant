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

const log = getLogger("desktop-dependencies");
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
  compositor: ["xcompmgr"],
  panel: ["tint2"],
  clipboard: ["tigervncconfig", "vncconfig"],
  terminal: ["xterm"],
} as const;

const DESKTOP_PACKAGES = [
  "dbus-x11",
  "openbox",
  "tigervnc-standalone-server",
  "tigervnc-common",
  "tint2",
  "xauth",
  "xcompmgr",
  "xfonts-base",
  "xterm",
  "fonts-liberation",
  "libgtk-3-0",
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
            existsSync("/usr/share/fonts/X11/misc/fonts.dir")
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
        this.status = { state: "failed" };
      })
      .finally(() => {
        this.installing = null;
        this.update(this.status!);
      });
    this.update(this.status);
    return this.status;
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
  await rm(desktopChromePath() + ".ready", { force: true });
  // Desktop binaries, X assets and the loader share the image root.
  await run([...apt, "update"]);
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
  ]);
  onStage("chrome");
  if (!existsSync(desktopChromePath())) {
    const downloadDir = await mkdtemp(join(tmpdir(), "desktop-chrome-"));
    const installRoot = join(getExternalDir(), "desktop");
    await mkdir(installRoot, { recursive: true });
    const staging = await mkdtemp(join(installRoot, ".install-"));
    try {
      const deb = join(downloadDir, "chrome.deb");
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
        deb,
        `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_${chrome.arch}.deb`,
      ]);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(deb)) {
        hash.update(chunk);
      }
      if (hash.digest("hex") !== chrome.sha256) {
        throw new Error("Chrome download checksum mismatch");
      }
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
  await run([desktopChromePath(), "--version"]);
  await writeFile(desktopChromePath() + ".ready", "");
}

export const desktopDependencyInstaller = new DesktopDependencyInstaller();
