import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Tag } from "@vellum/design-library/components/tag";
import { Toggle } from "@vellum/design-library/components/toggle";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import {
  useFeatureFlagStore,
  type AppFeatureFlags,
} from "@/lib/feature-flags/feature-flag-store.js";

interface FlagDefinition {
  ldKey: string;
  label: string;
  description: string;
  defaultValue: boolean | string;
}

interface AppFlagEntry {
  key: string;
  storeKey: keyof AppFeatureFlags;
  label: string;
  description: string;
  value: boolean | string;
  defaultValue: boolean | string;
}

const FLAG_DEFINITIONS: Record<string, FlagDefinition> = {
  a2aChannel: {
    ldKey: "a2a-channel",
    label: "A2A Channel",
    description:
      "Enable A2A (assistant-to-assistant) channel for inter-assistant communication on the Contacts page.",
    defaultValue: false,
  },
  accountDeletion: {
    ldKey: "account-deletion",
    label: "Account Deletion",
    description:
      "Surfaces the user-initiated account deletion flow in client settings.",
    defaultValue: false,
  },
  analyzeConversation: {
    ldKey: "analyze-conversation",
    label: "Analyze Conversation",
    description:
      "Show the 'Analyze' option in conversation context menus and title actions dropdown.",
    defaultValue: false,
  },
  chatPullToRefreshEnabled: {
    ldKey: "chat-pull-to-refresh-enabled",
    label: "Chat Pull to Refresh",
    description: "Enable pull-to-refresh gesture in the chat view.",
    defaultValue: false,
  },
  conversationGroupsUI: {
    ldKey: "conversation-groups-ui",
    label: "Conversation Groups",
    description:
      "Enable custom conversation group creation, move-to-group, and group management in the sidebar.",
    defaultValue: false,
  },
  deployToVercel: {
    ldKey: "deploy-to-vercel",
    label: "Deploy to Vercel",
    description:
      "Enable the Deploy to Vercel / Publish option in the app workspace header share menu.",
    defaultValue: false,
  },
  settingsDeveloperNav: {
    ldKey: "settings-developer-nav",
    label: "Settings Developer Nav",
    description: "Control Developer nav visibility in settings.",
    defaultValue: false,
  },
  doctor: {
    ldKey: "doctor",
    label: "Doctor",
    description: "Enable the Doctor diagnostic tab in Debug settings.",
    defaultValue: false,
  },
  multiPlatformAssistant: {
    ldKey: "multi-platform-assistant",
    label: "Multi-Platform Assistant Switcher",
    description:
      "Enable the assistant switcher for managing multiple platform-hosted assistants.",
    defaultValue: false,
  },
  platformNotifications: {
    ldKey: "platform-notifications",
    label: "Platform Notifications",
    description: "Enable the Notifications tab in settings.",
    defaultValue: false,
  },
  proPlanAdjust: {
    ldKey: "pro-plan-adjust",
    label: "Pro Plan Adjust",
    description: "Show the rich Plan card in the Billing tab.",
    defaultValue: false,
  },
  rollbackEnabled: {
    ldKey: "rollback-enabled",
    label: "Rollback Enabled",
    description:
      "Show older versions in the version picker, allowing rollback to previous releases.",
    defaultValue: false,
  },
  safeStorageLimits: {
    ldKey: "safe-storage-limits",
    label: "Safe Storage Limits",
    description:
      "Enable disk pressure protection flows that block background work while storage is critically low.",
    defaultValue: false,
  },
  selfHostedAssistant: {
    ldKey: "self-hosted-assistant",
    label: "Self-Hosted Assistant",
    description: "Enable self-hosted assistant configuration.",
    defaultValue: false,
  },
  settingsSleepPolicy: {
    ldKey: "settings-sleep-policy",
    label: "Settings Sleep Policy",
    description: "Enable sleep policy settings.",
    defaultValue: false,
  },
  sounds: {
    ldKey: "sounds",
    label: "Sounds",
    description:
      "Enable the Sounds tab in Settings and all app sound playback.",
    defaultValue: false,
  },
  homePage: {
    ldKey: "home-page",
    label: "Home Page",
    description: "Enable the Home page as the default landing view.",
    defaultValue: false,
  },
  openAICompatibleEndpoints: {
    ldKey: "openai-compatible-endpoints",
    label: "OpenAI-Compatible Endpoints",
    description:
      "Enable OpenAI-compatible provider connections in AI settings.",
    defaultValue: false,
  },
  velvet: {
    ldKey: "velvet",
    label: "Velvet",
    description: "Enable the Velvet design theme.",
    defaultValue: false,
  },
};

export function FeatureFlagsPanel() {
  const [searchText, setSearchText] = useState("");
  const storeState = useFeatureFlagStore();

  const flags: AppFlagEntry[] = useMemo(() => {
    const entries: AppFlagEntry[] = [];
    for (const [prop, def] of Object.entries(FLAG_DEFINITIONS)) {
      const value = storeState[prop as keyof AppFeatureFlags];
      entries.push({
        key: def.ldKey,
        storeKey: prop as keyof AppFeatureFlags,
        label: def.label,
        description: def.description,
        value,
        defaultValue: def.defaultValue,
      });
    }
    return entries.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
  }, [storeState]);

  const filteredFlags = useMemo(() => {
    if (!searchText.trim()) {
      return flags;
    }
    const query = searchText.trim().toLowerCase();
    return flags.filter(
      (flag) =>
        flag.label.toLowerCase().includes(query) ||
        flag.description.toLowerCase().includes(query) ||
        flag.key.toLowerCase().includes(query),
    );
  }, [flags, searchText]);

  return (
    <SettingsCard
      title="Feature Flags"
      subtitle="Active LaunchDarkly feature flags evaluated for the current session."
    >
      <div className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--content-tertiary)]" />
          <input
            type="text"
            placeholder="Search flags..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] py-2 pl-9 pr-3 text-body-medium-default text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:border-[var(--border-focus)] focus:outline-none"
          />
        </div>

        {filteredFlags.length === 0 && (
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            No matching flags.
          </p>
        )}

        {filteredFlags.length > 0 && (
          <div className="max-h-[500px] space-y-2 overflow-y-auto">
            {filteredFlags.map((flag) => (
              <FeatureFlagRow key={flag.key} flag={flag} />
            ))}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

interface FeatureFlagRowProps {
  flag: AppFlagEntry;
}

function FeatureFlagRow({ flag }: FeatureFlagRowProps) {
  const checked = typeof flag.value === "boolean" ? flag.value : null;
  const setFlag = useFeatureFlagStore.use.setFlag();

  return (
    <div className="flex items-start gap-3 py-3">
      <div className="shrink-0 pt-0.5">
        {checked !== null ? (
          <Toggle
            checked={checked}
            onChange={(next) => setFlag(flag.storeKey, next)}
            aria-label={`${flag.label} is ${checked ? "on" : "off"}`}
          />
        ) : (
          <Tag tone="neutral">{String(flag.value)}</Tag>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <span className="text-body-medium-default text-[var(--content-default)]">
          {flag.label}
        </span>
        {flag.description && (
          <div>
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              {flag.description}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1">
          <span className="text-body-small-default text-[var(--content-tertiary)]">
            Default:
          </span>
          <Tag tone="neutral">
            {typeof flag.defaultValue === "boolean"
              ? flag.defaultValue ? "On" : "Off"
              : String(flag.defaultValue)}
          </Tag>
        </div>
      </div>
    </div>
  );
}
