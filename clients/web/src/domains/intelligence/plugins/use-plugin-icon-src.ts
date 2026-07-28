import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { pluginsByNameIconGet } from "@/generated/daemon/sdk.gen";
import { useSupportsPluginIcons } from "@/lib/backwards-compat/use-supports-plugin-icons";

/**
 * Object URL for a plugin's bundled icon, or `undefined` when the daemon
 * doesn't serve icons (version gate) or the plugin ships none. Callers pass the
 * result to `<PluginIcon iconSrc>`, which falls back to the emoji/glyph.
 *
 * The icon is fetched through the authenticated daemon client so the request
 * interceptor rewrites it to the self-hosted gateway and attaches the
 * bearer/ngrok auth in local / remote-gateway modes. A bare `<img src>` would
 * bypass that interceptor and only load in same-origin platform deployments.
 * The bytes are held as an object URL and revoked on change/unmount, mirroring
 * `attachment-preview-modal`. Because the rendered `<img src>` is a `blob:` URL,
 * any Content-Security-Policy on the platform gateway (in vellum-assistant-platform)
 * must permit `img-src blob:`, or the icon silently falls back to the emoji/glyph.
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
  // `iconVersion` keys the query, so a byte change (new content hash) refetches
  // and bypasses the endpoint's immutable cache.
  const enabled = Boolean(supportsIcons && hasIcon && iconVersion);

  const { data: blob } = useQuery({
    queryKey: ["pluginIcon", assistantId, name, iconVersion],
    queryFn: async () => {
      const { data, error } = await pluginsByNameIconGet({
        path: { assistant_id: assistantId, name },
        parseAs: "blob",
        throwOnError: false,
      });
      if (error || !(data instanceof Blob)) {
        throw new Error("Failed to load plugin icon");
      }
      return data;
    },
    enabled,
    staleTime: Infinity,
    retry: false,
  });

  // Hold the fetched blob as an object URL for the `<img>`, and revoke it when
  // the blob changes or the consumer unmounts.
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!blob) {
      setObjectUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [blob]);

  return objectUrl;
}
