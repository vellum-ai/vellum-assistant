import { useSupportsPluginIcons } from "@/lib/backwards-compat/use-supports-plugin-icons";

import { buildPluginIconUrl } from "./plugin-icon-url";

/**
 * Bundled-icon endpoint URL for a plugin, or `undefined` when the daemon
 * doesn't serve icons (version gate) or the plugin ships none. Callers pass the
 * result to `<PluginIcon iconSrc>`, which falls back to the emoji/glyph.
 */
export function usePluginIconSrc(
  assistantId: string,
  name: string,
  hasIcon: boolean | undefined,
  // `null` accommodates the detail response, where `iconVersion` is nulled out
  // when `hasIcon` is false; the list row's field is `string | undefined`.
  iconVersion: string | null | undefined,
): string | undefined {
  const supportsIcons = useSupportsPluginIcons();
  return supportsIcons && hasIcon && iconVersion
    ? buildPluginIconUrl(assistantId, name, iconVersion)
    : undefined;
}
