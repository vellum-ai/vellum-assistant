import { useEffect, useRef, useState } from "react";

import { fetchAvatarImageUrlResult } from "@/assistant/avatar-api";
import { useTranslation } from "@/i18n";
import { trackBlobUrl } from "@/lib/blob-url-tracker";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { Button, Typography } from "@vellumai/design-library";

/** Side of the square preview, large enough to judge the image by. */
const PREVIEW_PX = 64;

export interface ChannelAvatarDownloadProps {
  /** Provider whose icon field this is for, used only to pick the copy. */
  channel: "slack" | "discord" | "telegram";
}

/**
 * Offers the assistant's avatar as a file, for the icon field of a channel bot.
 *
 * Every channel bot wears its provider's default icon until someone uploads
 * one by hand, and none of the three can be set from here: Slack keeps app
 * icons out of the manifest and behind a configuration token, Telegram accepts
 * one only through BotFather, and Discord's takes a credential this flow does
 * not hold. The wizard already has the user standing on the page that does
 * accept an upload, so the useful thing to hand them there is the file.
 *
 * The preview is the raster itself rather than the usual avatar rendering. A
 * character avatar is drawn client-side from its traits, so showing it that
 * way would preview something other than what downloads. Reading the same PNG
 * that the download link points at keeps the two identical.
 *
 * Renders nothing when there is no avatar to offer, which covers the `none`
 * kind and a workspace whose raster has not been written yet. An absent
 * suggestion is better than a broken thumbnail beside a dead link.
 */
export function ChannelAvatarDownload({ channel }: ChannelAvatarDownloadProps) {
  const { t } = useTranslation();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Owned by this component so it never revokes a URL another cache rendered.
  const urls = useRef(new Map<string, string>());

  useEffect(() => {
    const tracked = urls.current;
    if (!assistantId) {
      trackBlobUrl(tracked, "avatar", null);
      setImageUrl(null);
      return;
    }

    let active = true;
    void fetchAvatarImageUrlResult(assistantId).then((result) => {
      // A second assistant selected mid-flight must not overwrite the first.
      if (!active) {
        if (result.status === "found") {
          URL.revokeObjectURL(result.value);
        }
        return;
      }
      const next = result.status === "found" ? result.value : null;
      trackBlobUrl(tracked, "avatar", next);
      setImageUrl(next);
    });

    return () => {
      active = false;
    };
  }, [assistantId]);

  // Revoke on unmount only. Keyed separately from the fetch so selecting a new
  // assistant does not tear down the URL the effect above just stored.
  useEffect(() => {
    const tracked = urls.current;
    return () => {
      trackBlobUrl(tracked, "avatar", null);
    };
  }, []);

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
          {t(`channelAvatarDownload.prompt.${channel}`)}
        </Typography>
        <Button asChild variant="outlined">
          {/* The link owns the download, so a right-click "save as" works. */}
          <a href={imageUrl} download="assistant-avatar.png">
            {t("channelAvatarDownload.download")}
          </a>
        </Button>
      </div>
    </div>
  );
}
