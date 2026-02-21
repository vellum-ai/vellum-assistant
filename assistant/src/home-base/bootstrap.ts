import { getApp } from '../memory/app-store.js';
import { getLogger } from '../util/logger.js';
import {
  getHomeBaseAppLink,
  setHomeBaseAppLink,
  type HomeBaseAppLink,
} from './app-link-store.js';
import { ensurePrebuiltHomeBaseSeeded, findSeededHomeBaseApp } from './prebuilt/seed.js';

const log = getLogger('home-base-bootstrap');

function resolveExistingLink(): HomeBaseAppLink | null {
  const link = getHomeBaseAppLink();
  if (!link) return null;
  if (getApp(link.appId)) return link;
  return null;
}

export interface HomeBaseBootstrapResult {
  appId: string;
  source: string;
  linked: boolean;
  created: boolean;
}

export function bootstrapHomeBaseAppLink(): HomeBaseBootstrapResult | null {
  const linked = resolveExistingLink();
  if (linked) {
    return {
      appId: linked.appId,
      source: linked.source,
      linked: true,
      created: false,
    };
  }

  const discovered = findSeededHomeBaseApp();
  if (discovered) {
    const next = setHomeBaseAppLink(discovered.id, 'prebuilt_seed');
    return {
      appId: next.appId,
      source: next.source,
      linked: true,
      created: false,
    };
  }

  const seeded = ensurePrebuiltHomeBaseSeeded();
  if (!seeded) return null;

  const next = setHomeBaseAppLink(seeded.appId, 'prebuilt_seed');
  log.info({ appId: next.appId, created: seeded.created }, 'Bootstrapped Home Base app link');

  return {
    appId: next.appId,
    source: next.source,
    linked: true,
    created: seeded.created,
  };
}

export function resolveHomeBaseAppId(): string | null {
  const linked = resolveExistingLink();
  if (linked) return linked.appId;

  const discovered = findSeededHomeBaseApp();
  return discovered?.id ?? null;
}
