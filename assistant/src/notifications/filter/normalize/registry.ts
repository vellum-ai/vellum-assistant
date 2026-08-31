/**
 * Registry of notification normalizers, mirroring `watcher/provider-registry.ts`.
 *
 * Registration is keyed by `source`, so re-registering a source replaces the
 * previous entry rather than adding a second one.
 */

import { getLogger } from "../../../util/logger.js";
import type { WatcherItem } from "../../../watcher/provider-types.js";
import { gmailNormalizer } from "./gmail.js";
import { linearNormalizer } from "./linear.js";
import type {
  NormalizedNotification,
  NotificationNormalizer,
} from "./types.js";

const log = getLogger("notification-filter:registry");

const normalizers = new Map<string, NotificationNormalizer>();

export function registerNormalizer(normalizer: NotificationNormalizer): void {
  normalizers.set(normalizer.source, normalizer);
}

export function getNormalizer(
  source: string,
): NotificationNormalizer | undefined {
  return normalizers.get(source);
}

export function listNormalizers(): NotificationNormalizer[] {
  return Array.from(normalizers.values());
}

/**
 * Normalize a raw watcher item from the provider that produced it.
 * A provider with no registered normalizer is inert, not fatal: it yields null
 * so an unmapped source flows through the pipeline untouched.
 */
export function normalizeWatcherItem(
  providerId: string,
  item: WatcherItem,
): NormalizedNotification | null {
  const normalizer = getNormalizer(providerId);
  if (!normalizer) {
    log.debug(
      { providerId, externalId: item.externalId },
      "No notification normalizer registered for provider",
    );
    return null;
  }
  return normalizer.normalize(item);
}

registerNormalizer(linearNormalizer);
registerNormalizer(gmailNormalizer);
