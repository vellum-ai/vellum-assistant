import type { QueryClient } from "@tanstack/react-query";

import { supersedePlatformAvatar } from "@/hooks/use-platform-avatar-urls";
import {
  deleteLastSeenAvatar,
  lastSeenAvatarGenerations,
  writeLastSeenAvatar,
} from "@/lib/avatar-last-seen-cache";
import type { AvatarRead } from "@/types/avatar";

/** The chooser's query over the last-seen cache; invalidated after every persist. */
export function chooserRowAvatarCacheQueryKey(assistantId: string) {
  return ["chooserRowAvatarCache", assistantId] as const;
}

/**
 * Writes a conclusive live resolution to the last-seen cache; an empty avatar
 * deletes the entry. Shared by every live source (the active assistant's hook
 * and the chooser's per-row fetch) so the cache fills whenever an avatar is
 * read, not only while the chooser is mounted. Claims a persistence generation
 * up front so a blob read that resolves after a newer write or delete
 * (including a retire) commits nothing. Invalidates the chooser's cache query
 * once committed so a row that falls back later reads the fresh entry, and
 * drops the row's synced `avatarUrl` and platform lookup entry: live evidence
 * outranks a thumbnail observed earlier, so the cache path wins until the
 * next list load carries a newer URL. Best-effort like the cache: never throws.
 */
export async function persistLastSeenAvatar(
  queryClient: QueryClient,
  assistantId: string,
  avatar: AvatarRead,
): Promise<void> {
  const generation = lastSeenAvatarGenerations.claim(assistantId);
  try {
    if (avatar.imageUrl) {
      const blob = await fetch(avatar.imageUrl).then((r) => r.blob());
      if (!lastSeenAvatarGenerations.isCurrent(assistantId, generation)) {
        return;
      }
      await writeLastSeenAvatar(
        assistantId,
        { kind: "image", blob },
        generation,
      );
    } else if (avatar.traits) {
      await writeLastSeenAvatar(
        assistantId,
        { kind: "character", traits: avatar.traits },
        generation,
      );
    } else {
      await deleteLastSeenAvatar(assistantId, generation);
    }
  } catch {
    // A blob that cannot be read back is simply not cached.
    return;
  }
  supersedePlatformAvatar(queryClient, assistantId);
  void queryClient.invalidateQueries({
    queryKey: chooserRowAvatarCacheQueryKey(assistantId),
  });
}
