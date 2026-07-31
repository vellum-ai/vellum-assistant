import { useEffect, useState } from "react";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";

type Llm = ConfigGetResponse["llm"];

/** The `llm.profiles` map as served by `GET /v1/config`. */
export type ProfileMap = NonNullable<NonNullable<Llm>["profiles"]>;

export interface StickyProfiles {
  profiles: ProfileMap;
  profileOrder: string[];
}

const EMPTY: StickyProfiles = { profiles: {}, profileOrder: [] };

/**
 * Read `llm.profiles` / `llm.profileOrder` from the shared daemon-config query,
 * retaining the last non-empty snapshot.
 *
 * Managed profiles are always daemon-seeded, so an empty profile map is never a
 * legitimate steady state — it only appears transiently (e.g. a partial config
 * payload written into the shared query cache while the daemon rewrites
 * settings.json). Falling back to the last non-empty list during that window
 * stops the profile pickers (composer Model Profile menu, settings Default
 * Profile dropdown) from blanking until the next good fetch. Before this guard,
 * a momentary empty config latched the picker empty until a full page reload.
 *
 * Pass `resetKey` (the assistant id) so the retained snapshot is dropped when
 * the context it belongs to changes — otherwise switching assistants could
 * briefly show the previous assistant's profiles before the new config loads.
 */
export function useStickyProfiles(
  llm: Llm | undefined,
  resetKey?: string,
): StickyProfiles {
  const liveProfiles = llm?.profiles;
  const liveOrder = llm?.profileOrder;
  const hasLive = !!liveProfiles && Object.keys(liveProfiles).length > 0;

  const [sticky, setSticky] = useState<StickyProfiles>(EMPTY);

  // Reset the retained snapshot when the context changes (React's "adjust state
  // during render" pattern). Runs before the effect below so a context switch
  // never serves the previous context's stale profiles.
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setSticky(EMPTY);
  }

  useEffect(() => {
    if (hasLive) {
      setSticky({ profiles: liveProfiles, profileOrder: liveOrder ?? [] });
    }
  }, [hasLive, liveProfiles, liveOrder]);

  if (hasLive) {
    return { profiles: liveProfiles, profileOrder: liveOrder ?? [] };
  }
  return resetKey !== prevResetKey ? EMPTY : sticky;
}
