import type { TFunction } from "@/i18n";
import { toast } from "@vellumai/design-library";

const MCP_OAUTH_CREDENTIALS_UNCHECKED =
  "plugin.uninstall.mcp_oauth_credentials_unchecked";

export function showPluginUninstallWarnings(
  warnings: readonly string[] | undefined,
  t: TFunction<"intelligence">,
): void {
  for (const warning of warnings ?? []) {
    toast.warning(
      warning === MCP_OAUTH_CREDENTIALS_UNCHECKED
        ? t("pluginToast.mcpOAuthCredentialsUnchecked")
        : t("pluginToast.cleanupWarning"),
    );
  }
}
