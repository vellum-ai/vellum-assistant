export interface BundledCliModules {
  configEnv: typeof import("../config/env.js");
  providerSecretCatalog: typeof import("../providers/provider-secret-catalog.js");
  pluginCatalogCache: typeof import("./lib/plugin-catalog-cache.js");
  pluginCatalogLocal: typeof import("./lib/plugin-catalog-local.js");
  pluginDiff: typeof import("./lib/diff-plugin.js");
  pluginInspect: typeof import("./lib/inspect-plugin.js");
  pluginInstallGitHub: typeof import("./lib/install-from-github.js");
  pluginInstallPlatform: typeof import("./lib/install-from-platform.js");
  pluginInstalled: typeof import("./lib/list-installed-plugins.js");
  pluginPinHistory: typeof import("./lib/plugin-pin-history.js");
  pluginSearch: typeof import("./lib/search-plugins.js");
  pluginSurfaces: typeof import("./lib/plugin-surfaces.js");
  pluginUninstall: typeof import("./lib/uninstall-plugin.js");
  pluginUpgrade: typeof import("./lib/upgrade-plugin.js");
}

let bundledCliModules: BundledCliModules | undefined;

export function setBundledCliModules(modules: BundledCliModules): void {
  bundledCliModules = modules;
}

export function resolveBundledCliModule<K extends keyof BundledCliModules>(
  name: K,
  fallback: () => BundledCliModules[K],
): BundledCliModules[K] {
  return bundledCliModules?.[name] ?? fallback();
}
