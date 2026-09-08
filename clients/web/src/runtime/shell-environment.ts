/**
 * Which build of the native shell is hosting the running web bundle.
 *
 * `VITE_SENTRY_ENVIRONMENT` answers a different question: it names the web
 * bundle's own deploy, and any installed shell can load any deploy, so an App
 * Staging build pointed at a dev server reports "dev" while its home screen
 * still holds the Staging icon. Anything depicting the shell itself, rather
 * than the bundle, has to read the shell.
 *
 * The application id is the shell fact that differs per build and needs no
 * native code of its own: iOS sets it per scheme in
 * `clients/ios/App/App/Config/App{,-Dev,-Staging}.xcconfig`, Android suffixes
 * it per flavor in `clients/android/app/build.gradle`, and `@capacitor/app`
 * hands it back on both.
 *
 * Resolves null off a native shell and for any id neither project claims, so
 * callers have one unknown to handle and no error branch to write.
 */

import { useEffect, useState } from "react";

/** The environments a shell can be built for, matching its icon's ground. */
export type ShellEnvironment = "production" | "staging" | "dev";

/** Unsuffixed application ids: iOS first, then Android. */
const SHELL_APP_ID_BASES = [
  "ai.vocify-inc.vellum-assistant-ios",
  "ai.vellum.assistant",
];

/** Suffix each build appends to its base id, production appending none. */
const SHELL_ENVIRONMENT_BY_SUFFIX: Record<string, ShellEnvironment> = {
  "": "production",
  ".staging": "staging",
  ".dev": "dev",
};

/** The environment an application id names, null when it names none. */
export function shellEnvironmentForAppId(
  appId: string,
): ShellEnvironment | null {
  for (const base of SHELL_APP_ID_BASES) {
    if (!appId.startsWith(base)) {
      continue;
    }
    const environment = SHELL_ENVIRONMENT_BY_SUFFIX[appId.slice(base.length)];
    if (environment) {
      return environment;
    }
  }
  return null;
}

/**
 * Read the hosting shell's environment, null when it cannot be identified.
 *
 * Ungated: off a native shell `getInfo` simply rejects, which is the same
 * unknown as an id nobody claims. `console.debug` rather than `captureError`
 * for that reason, since a web or Electron caller is not a fault.
 */
export async function getShellEnvironment(): Promise<ShellEnvironment | null> {
  try {
    // `@capacitor/app` is a plugin Proxy, so it is destructured inline per
    // `docs/CAPACITOR.md`.
    const { App } = await import("@capacitor/app");
    const { id } = await App.getInfo();
    return shellEnvironmentForAppId(id);
  } catch (err) {
    console.debug("[shell-environment] no native shell identity:", err);
    return null;
  }
}

/**
 * Hook form of {@link getShellEnvironment}, `undefined` until the shell has
 * answered and null thereafter when it named nothing recognizable. The bridge
 * is asynchronous, so a caller drawing the shell has one frame to fill before
 * it knows which shell it is in.
 */
export function useShellEnvironment(): ShellEnvironment | null | undefined {
  const [environment, setEnvironment] = useState<ShellEnvironment | null>();

  useEffect(() => {
    let active = true;
    void getShellEnvironment().then((resolved) => {
      if (active) {
        setEnvironment(resolved);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return environment;
}
