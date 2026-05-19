import { useEffect, useLayoutEffect, useState } from "react";

import { assistantsList, organizationsList } from "@/generated/api/sdk.gen.js";
import { useAuth } from "@/lib/auth.js";
import { useMarketingFeatureFlags } from "@/lib/feature-flags/marketing.js";
import { hasReturningUserSignal } from "@/lib/onboarding/prefs.js";

const ASSISTANT_NAME_CACHE_KEY = "vellum_assistant_name";

interface CachedAssistantName {
  userId: string;
  name: string;
}

function readCache(): CachedAssistantName | null {
  try {
    const raw = localStorage.getItem(ASSISTANT_NAME_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedAssistantName;
  } catch {
    return null;
  }
}

function writeCache(userId: string, name: string | null): void {
  try {
    if (name) {
      localStorage.setItem(ASSISTANT_NAME_CACHE_KEY, JSON.stringify({ userId, name }));
    } else {
      localStorage.removeItem(ASSISTANT_NAME_CACHE_KEY);
    }
  } catch {}
}

export function useNavbarAuth() {
  const { isLoggedIn, isLoading, userId } = useAuth();
  const { webUiSignup } = useMarketingFeatureFlags();

  const [isReturningUser, setIsReturningUser] = useState(false);
  const [assistantName, setAssistantName] = useState<string | null>(null);

  useLayoutEffect(() => {
    setIsReturningUser(hasReturningUserSignal());
    const cached = readCache();
    if (cached) {
      setAssistantName(cached.name);
    }
  }, []);

  // Once auth resolves, clear stale cache from a different user.
  useEffect(() => {
    if (isLoading) return;
    if (!isLoggedIn) {
      return;
    }
    if (userId) {
      const cached = readCache();
      if (cached && cached.userId !== userId) {
        writeCache(userId, null);
        setAssistantName(null);
      }
    }
  }, [isLoading, isLoggedIn, userId]);

  // Fetch fresh name and update cache.
  useEffect(() => {
    if (!isLoggedIn || !webUiSignup || !userId) return;
    let cancelled = false;
    organizationsList()
      .then((orgsRes) => {
        const orgId = orgsRes.data?.results?.[0]?.id;
        if (cancelled || !orgId) return;
        return assistantsList({
          headers: { "Vellum-Organization-Id": orgId },
        });
      })
      .then((res) => {
        if (cancelled) return;
        const name = res?.data?.results?.[0]?.name ?? null;
        writeCache(userId, name);
        setAssistantName(name);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isLoggedIn, webUiSignup, userId]);

  return { isLoggedIn, isLoading, webUiSignup, isReturningUser, assistantName };
}
