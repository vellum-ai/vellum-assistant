import { setBundledCliModules } from "./cli/bundled-modules.js";
import * as pluginDiff from "./cli/lib/diff-plugin.js";
import * as pluginInspect from "./cli/lib/inspect-plugin.js";
import * as pluginInstallGitHub from "./cli/lib/install-from-github.js";
import * as pluginInstallPlatform from "./cli/lib/install-from-platform.js";
import * as pluginInstalled from "./cli/lib/list-installed-plugins.js";
import * as pluginCatalogCache from "./cli/lib/plugin-catalog-cache.js";
import * as pluginCatalogLocal from "./cli/lib/plugin-catalog-local.js";
import * as pluginPinHistory from "./cli/lib/plugin-pin-history.js";
import * as pluginSurfaces from "./cli/lib/plugin-surfaces.js";
import * as pluginSearch from "./cli/lib/search-plugins.js";
import * as pluginUninstall from "./cli/lib/uninstall-plugin.js";
import * as pluginUpgrade from "./cli/lib/upgrade-plugin.js";
import * as configEnv from "./config/env.js";
import * as providerSecretCatalog from "./providers/provider-secret-catalog.js";

setBundledCliModules({
  configEnv,
  providerSecretCatalog,
  pluginCatalogCache,
  pluginCatalogLocal,
  pluginDiff,
  pluginInspect,
  pluginInstallGitHub,
  pluginInstallPlatform,
  pluginInstalled,
  pluginPinHistory,
  pluginSearch,
  pluginSurfaces,
  pluginUninstall,
  pluginUpgrade,
});
