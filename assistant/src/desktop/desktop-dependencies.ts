import { existsSync } from "node:fs";

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

export function desktopChromePath(): string {
  return "/opt/google/chrome/chrome";
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

function desktopSystemDependenciesReady(): boolean {
  try {
    resolveDesktopBinaries();
    return (
      existsSync("/usr/games/gnome-mines") &&
      existsSync("/usr/share/dbus-1/services/org.gtk.vfs.Daemon.service") &&
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
}

export const desktopDependencies = {
  getStatus(): { state: "ready" | "failed" | "unsupported" } {
    if (
      process.platform !== "linux" ||
      !["x64", "arm64"].includes(process.arch) ||
      process.getuid?.() !== 0
    ) {
      return { state: "unsupported" };
    }
    return {
      state:
        desktopSystemDependenciesReady() && existsSync(desktopChromePath())
          ? "ready"
          : "failed",
    };
  },

  assertReady(): void {
    const { state } = this.getStatus();
    if (state === "unsupported") {
      throw new Error("Virtual desktop is unsupported on this assistant.");
    }
    if (state !== "ready") {
      throw new Error(
        "Desktop components are missing from the assistant image. Update the assistant image. Do not install packages or launch Chrome manually.",
      );
    }
  },
};
