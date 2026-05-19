
import { createContext, useContext, useMemo, type ReactNode } from "react";

interface MarketingFeatureFlags {
  webUiSignup: boolean;
}

const DEFAULT_FLAGS: MarketingFeatureFlags = {
  webUiSignup: false,
};

const MarketingFeatureFlagContext = createContext<MarketingFeatureFlags>(DEFAULT_FLAGS);

export function MarketingFeatureFlagProvider({
  webUiSignup,
  children,
}: MarketingFeatureFlags & { children: ReactNode }) {
  const value = useMemo(() => ({ webUiSignup }), [webUiSignup]);

  return (
    <MarketingFeatureFlagContext value={value}>
      {children}
    </MarketingFeatureFlagContext>
  );
}

export function useMarketingFeatureFlags(): MarketingFeatureFlags {
  return useContext(MarketingFeatureFlagContext);
}
