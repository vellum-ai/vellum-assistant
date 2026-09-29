import type { ComposerConfiguration } from "@/domains/chat/hooks/use-composer-configuration";

export function composerConfigurationFixture(): ComposerConfiguration {
  const profiles = [
    { name: "auto", label: "Auto" },
    { name: "balanced", label: "Balanced" },
    { name: "quality-optimized", label: "Quality" },
    { name: "latency-optimized", label: "Fast" },
    { name: "cost-optimized", label: "Budget" },
    { name: "os-beta", label: "OS Beta" },
  ].map((entry) => ({
    ...entry,
    source: "managed" as const,
    provider: "anthropic" as const,
    model: "claude-fable-5",
  }));
  return {
    open: true,
    setOpen: () => {},
    mode: "balanced",
    autonomy: "medium",
    profiles,
    allProfiles: profiles,
    favorites: profiles.slice(0, 5),
    preferences: {
      favoriteModeIds: [],
      lastModeId: null,
      lastAutonomy: null,
    },
    preferencesAvailable: true,
    supportsPreferences: true,
    modeReady: true,
    autonomyReady: true,
    readyForDraft: true,
    selectMode: async () => true,
    selectAutonomy: async () => true,
    newMode: () => {},
    requireOwnProviderAndModel: true,
  };
}
