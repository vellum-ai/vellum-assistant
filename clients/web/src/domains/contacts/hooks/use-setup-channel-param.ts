import { useEffect } from "react";
import { useSearchParams } from "react-router";

import { isSetupChannelId, type SetupChannelId } from "@/domains/contacts/types";

/**
 * Reads the `?setup=<channel>` deep-link param (used to pre-select a channel
 * tab on arrival) and consumes it once on mount so it doesn't persist
 * across navigations. Returns the channel on the first render and `null`
 * after the param is cleared or when it names no known channel.
 */
export function useSetupChannelParam(): SetupChannelId | null {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSetup = searchParams.get("setup");
  const setupChannel = rawSetup && isSetupChannelId(rawSetup) ? rawSetup : null;

  useEffect(() => {
    if (!setupChannel) {
      return;
    }
    setSearchParams((prev) => { prev.delete("setup"); return prev; }, { replace: true });
  }, [setupChannel, setSearchParams]);

  return setupChannel;
}
