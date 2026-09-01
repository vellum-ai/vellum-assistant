import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { avatarRasterQueryKey } from "./channel-avatar-download";

/**
 * A 1x1 green PNG standing in for the rendered avatar. Seeded into the cache
 * under the raster key so `ChannelAvatarDownload` renders without a daemon:
 * the component reads its file through TanStack Query, and a story owns that
 * cache.
 */
const AVATAR_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+s9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Story decorator for the channel setup wizards, whose create/token steps
 * render `ChannelAvatarDownload`. Pass `hasAvatar: false` for the state
 * where there is no avatar to offer and the card renders nothing.
 */
export function withAvatar(assistantId: string, hasAvatar: boolean) {
  return function Decorator(Story: () => React.ReactElement) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(
      avatarRasterQueryKey(assistantId),
      hasAvatar ? AVATAR_DATA_URI : null,
    );
    return (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    );
  };
}
