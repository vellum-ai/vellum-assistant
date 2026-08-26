import {
  deleteLastSeenAvatar,
  lastSeenAvatarGenerations,
  writeLastSeenAvatar,
} from "@/lib/avatar-last-seen-cache";
import type { CharacterTraits } from "@/types/avatar";

export interface LiveAvatarResolution {
  traits: CharacterTraits | null;
  imageUrl: string | null;
}

/**
 * Writes a conclusive live resolution to the last-seen cache; an empty avatar
 * deletes the entry. Shared by every live source (the active assistant's hook
 * and the chooser's per-row fetch) so the cache fills whenever an avatar is
 * read, not only while the chooser is mounted. Claims a persistence generation
 * up front so a blob read that resolves after a newer write or delete
 * (including a retire) commits nothing. Best-effort like the cache: never
 * throws.
 */
export async function persistLastSeenAvatar(
  assistantId: string,
  avatar: LiveAvatarResolution,
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
  }
}
