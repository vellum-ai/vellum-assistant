import type { QueryClient } from "@tanstack/react-query";

import { withQueryCache } from "@/lib/story-query-cache";

import { avatarRasterQueryKey } from "./channel-avatar-download";

/**
 * A 1x1 green PNG standing in for the rendered avatar. Seeded into the cache
 * under the raster key so `ChannelAvatarDownload` renders without a daemon:
 * the component reads its file through TanStack Query, and a story owns that
 * cache.
 */
export const STORY_AVATAR_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+s9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Story decorator for the channel setup wizards, whose create/token steps
 * render `ChannelAvatarDownload`. Pass `hasAvatar: false` for the state
 * where there is no avatar to offer and the card renders nothing. `seed`
 * stages any further cache state a story needs on the same client. The cache
 * is made once per call, like every `withQueryCache` decorator.
 */
export function withAvatarRaster(
  assistantId: string,
  hasAvatar: boolean,
  seed?: (client: QueryClient) => void,
) {
  return withQueryCache((client) => {
    client.setQueryData(
      avatarRasterQueryKey(assistantId),
      hasAvatar ? STORY_AVATAR_DATA_URI : null,
    );
    seed?.(client);
  });
}
