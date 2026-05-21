export type FlagScope = "client" | "assistant";

interface FlagEntry {
  scope: FlagScope;
  defaultEnabled: boolean;
}

export const FLAG_CATALOG = {
  // Client flags
  accountDeletion: { scope: "client", defaultEnabled: false },
  chatPullToRefreshEnabled: { scope: "client", defaultEnabled: false },
  doctor: { scope: "client", defaultEnabled: false },
  homePage: { scope: "client", defaultEnabled: false },
  platformNotifications: { scope: "client", defaultEnabled: false },
  rollbackEnabled: { scope: "client", defaultEnabled: false },
  selfHostedAssistant: { scope: "client", defaultEnabled: false },
  settingsDeveloperNav: { scope: "client", defaultEnabled: false },
  settingsSleepPolicy: { scope: "client", defaultEnabled: false },
  velvet: { scope: "client", defaultEnabled: false },

  // Assistant flags
  a2aChannel: { scope: "assistant", defaultEnabled: false },
  analyzeConversation: { scope: "assistant", defaultEnabled: false },
  conversationGroupsUI: { scope: "assistant", defaultEnabled: false },
  deployToVercel: { scope: "assistant", defaultEnabled: false },
  multiPlatformAssistant: { scope: "assistant", defaultEnabled: false },
  openAICompatibleEndpoints: { scope: "assistant", defaultEnabled: false },
  proPlanAdjust: { scope: "assistant", defaultEnabled: false },
  safeStorageLimits: { scope: "assistant", defaultEnabled: false },
  sounds: { scope: "assistant", defaultEnabled: false },
} as const satisfies Record<string, FlagEntry>;

type Catalog = typeof FLAG_CATALOG;
type FlagKeysForScope<S extends FlagScope> = {
  [K in keyof Catalog]: Catalog[K]["scope"] extends S ? K : never;
}[keyof Catalog];

export type ClientFlagKey = FlagKeysForScope<"client">;
export type AssistantFlagKey = FlagKeysForScope<"assistant">;
export type ClientFeatureFlags = Record<ClientFlagKey, boolean>;
export type AssistantFeatureFlags = Record<AssistantFlagKey, boolean>;

export function defaultsForScope<S extends FlagScope>(scope: S) {
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(FLAG_CATALOG)) {
    if (entry.scope === scope) {
      result[key] = entry.defaultEnabled;
    }
  }
  return result as Record<FlagKeysForScope<S>, boolean>;
}
