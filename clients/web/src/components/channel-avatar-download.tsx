import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchAvatarImageUrlResult } from "@/assistant/avatar-api";
import { useTranslation } from "@/i18n";
import { trackBlobUrl } from "@/lib/blob-url-tracker";
import { Button, Typography } from "@vellumai/design-library";

/** Side of the square preview, large enough to judge the image by. */
const PREVIEW_PX = 64;

/** Name the raster is offered under, rather than the blob id. */
const DOWNLOAD_FILENAME = "assistant-avatar.png";

/**
 * Written out per channel rather than composed from one. `catalogs.test.ts`
 * finds a key by searching source for its literal, so a computed key reads as
 * copy nothing references and fails the orphan check.
 */
const PROMPT_KEY = {
  slack: "channelAvatarDownload.prompt.slack",
  discord: "channelAvatarDownload.prompt.discord",
  telegram: "channelAvatarDownload.prompt.telegram",
} as const;

/**
 * Key for the avatar raster as a downloadable file, distinct from
 * `avatarQueryKey`, which resolves an avatar for display and prefers traits.
 * Exported so a story or test can seed the cache instead of reaching a daemon.
 */
export function avatarRasterQueryKey(assistantId: string) {
  return ["assistantAvatarRaster", assistantId] as const;
}

/** Object URLs this query owns, so a refetch revokes the one it replaces. */
const rasterUrls = new Map<string, string>();

export interface ChannelAvatarDownloadProps {
  /**
   * Assistant whose avatar to offer. Taken as a prop rather than read from
   * the active-assistant store: the setup flow pins every query and credential
   * write to the assistant its panel was opened for, so an assistant switch
   * mid-setup must not swap which avatar this card offers.
   */
  assistantId: string;
  /** Provider whose icon field this is for, used only to pick the copy. */
  channel: "slack" | "discord" | "telegram";
}

/**
 * Offers the assistant's avatar as a file, for the icon field of a channel bot.
 *
 * Every channel bot wears its provider's default icon until someone uploads
 * one by hand, and none of the three can be set from here: Telegram has no API
 * for it, Discord's needs a credential this flow does not hold, and Slack's
 * `apps.icon.set` needs a configuration token that expires in hours. The
 * wizard already has the user standing on the page that does accept an upload,
 * so the useful thing to hand them there is the file.
 *
 * The preview is the raster itself rather than the usual avatar rendering.
 * `ChatAvatar` resolves traits ahead of a custom image, so a character avatar
 * would preview as its client-side drawing while a PNG downloaded. Reading the
 * same file the download writes keeps the two identical, which is the whole
 * point of the control.
 *
 * Saving goes through `saveFile` rather than an anchor. A `blob:` anchor does
 * not download on Capacitor iOS, where this wizard is reachable, and that
 * helper already stages the blob through Filesystem and Share there.
 *
 * Renders nothing when there is no avatar to offer, which covers the `none`
 * kind and a workspace whose raster has not been written yet. An absent
 * suggestion is better than a broken thumbnail beside a dead control.
 */
export function ChannelAvatarDownload({
  assistantId,
  channel,
}: ChannelAvatarDownloadProps) {
  const { t } = useTranslation();

  const { data: imageUrl } = useQuery<string | null>({
    queryKey: avatarRasterQueryKey(assistantId),
    queryFn: async () => {
      const result = await fetchAvatarImageUrlResult(assistantId);
      const url = result.status === "found" ? result.value : null;
      // Tracked inside the fetch so a refetch revokes the URL it replaces
      // rather than leaking one per render of the wizard.
      trackBlobUrl(rasterUrls, assistantId, url);
      return url;
    },
    staleTime: Infinity,
  });

  const handleDownload = useCallback(async () => {
    if (!imageUrl) {
      return;
    }
    const { saveFile } = await import("@/runtime/native-file");
    await saveFile(imageUrl, DOWNLOAD_FILENAME);
  }, [imageUrl]);

  if (!imageUrl) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 rounded-md border border-[color:var(--border-default)] p-3">
      <img
        src={imageUrl}
        alt={t("channelAvatarDownload.previewAlt")}
        width={PREVIEW_PX}
        height={PREVIEW_PX}
        className="shrink-0 rounded-md"
      />
      <div className="flex flex-col items-start gap-2">
        <Typography
          as="p"
          variant="body-medium-lighter"
          className="text-[color:var(--content-default)]"
        >
          {t(PROMPT_KEY[channel])}
        </Typography>
        <Button type="button" variant="outlined" onClick={handleDownload}>
          {t("channelAvatarDownload.download")}
        </Button>
      </div>
    </div>
  );
}
