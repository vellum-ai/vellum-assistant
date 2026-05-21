import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Tag } from "@vellum/design-library/components/tag";
import { Toggle } from "@vellum/design-library/components/toggle";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store.js";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";
import {
  FLAG_CATALOG,
  type ClientFlagKey,
  type AssistantFlagKey,
  type FlagScope,
} from "@/lib/feature-flags/feature-flag-catalog.js";

interface FlagDisplayEntry {
  key: string;
  catalogKey: string;
  scope: FlagScope;
  label: string;
  description: string;
  value: boolean;
  defaultValue: boolean;
}

const FLAG_META: Record<
  string,
  { label: string; description: string }
> = {
  a2aChannel: {
    label: "A2A Channel",
    description:
      "Enable A2A (assistant-to-assistant) channel for inter-assistant communication on the Contacts page.",
  },
  accountDeletion: {
    label: "Account Deletion",
    description:
      "Surfaces the user-initiated account deletion flow in client settings.",
  },
  analyzeConversation: {
    label: "Analyze Conversation",
    description:
      "Show the 'Analyze' option in conversation context menus and title actions dropdown.",
  },
  chatPullToRefreshEnabled: {
    label: "Chat Pull to Refresh",
    description: "Enable pull-to-refresh gesture in the chat view.",
  },
  conversationGroupsUI: {
    label: "Conversation Groups",
    description:
      "Enable custom conversation group creation, move-to-group, and group management in the sidebar.",
  },
  deployToVercel: {
    label: "Deploy to Vercel",
    description:
      "Enable the Deploy to Vercel / Publish option in the app workspace header share menu.",
  },
  settingsDeveloperNav: {
    label: "Settings Developer Nav",
    description: "Control Developer nav visibility in settings.",
  },
  doctor: {
    label: "Doctor",
    description: "Enable the Doctor diagnostic tab in Debug settings.",
  },
  multiPlatformAssistant: {
    label: "Multi-Platform Assistant Switcher",
    description:
      "Enable the assistant switcher for managing multiple platform-hosted assistants.",
  },
  platformNotifications: {
    label: "Platform Notifications",
    description: "Enable the Notifications tab in settings.",
  },
  proPlanAdjust: {
    label: "Pro Plan Adjust",
    description: "Show the rich Plan card in the Billing tab.",
  },
  rollbackEnabled: {
    label: "Rollback Enabled",
    description:
      "Show older versions in the version picker, allowing rollback to previous releases.",
  },
  safeStorageLimits: {
    label: "Safe Storage Limits",
    description:
      "Enable disk pressure protection flows that block background work while storage is critically low.",
  },
  selfHostedAssistant: {
    label: "Self-Hosted Assistant",
    description: "Enable self-hosted assistant configuration.",
  },
  settingsSleepPolicy: {
    label: "Settings Sleep Policy",
    description: "Enable sleep policy settings.",
  },
  sounds: {
    label: "Sounds",
    description:
      "Enable the Sounds tab in Settings and all app sound playback.",
  },
  homePage: {
    label: "Home Page",
    description: "Enable the Home page as the default landing view.",
  },
  openAICompatibleEndpoints: {
    label: "OpenAI-Compatible Endpoints",
    description:
      "Enable OpenAI-compatible provider connections in AI settings.",
  },
  velvet: {
    label: "Velvet",
    description: "Enable the Velvet design theme.",
  },
};

export function FeatureFlagsPanel() {
  const [searchText, setSearchText] = useState("");
  const clientState = useClientFeatureFlagStore();
  const assistantState = useAssistantFeatureFlagStore();

  const flags: FlagDisplayEntry[] = useMemo(() => {
    const entries: FlagDisplayEntry[] = [];
    for (const [key, catalogEntry] of Object.entries(FLAG_CATALOG)) {
      const meta = FLAG_META[key];
      if (!meta) continue;
      const value =
        catalogEntry.scope === "client"
          ? clientState[key as ClientFlagKey]
          : assistantState[key as AssistantFlagKey];
      entries.push({
        key,
        catalogKey: key,
        scope: catalogEntry.scope,
        label: meta.label,
        description: meta.description,
        value,
        defaultValue: catalogEntry.defaultEnabled,
      });
    }
    return entries.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
  }, [clientState, assistantState]);

  const filteredFlags = useMemo(() => {
    if (!searchText.trim()) {
      return flags;
    }
    const query = searchText.trim().toLowerCase();
    return flags.filter(
      (flag) =>
        flag.label.toLowerCase().includes(query) ||
        flag.description.toLowerCase().includes(query) ||
        flag.key.toLowerCase().includes(query) ||
        flag.scope.toLowerCase().includes(query),
    );
  }, [flags, searchText]);

  return (
    <SettingsCard
      title="Feature Flags"
      subtitle="Active feature flags evaluated for the current session."
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
  flag: FlagDisplayEntry;
}

function FeatureFlagRow({ flag }: FeatureFlagRowProps) {
  const clientSetFlag = useClientFeatureFlagStore.use.setFlag();
  const assistantSetFlag = useAssistantFeatureFlagStore.use.setFlag();

  const handleToggle = (next: boolean) => {
    if (flag.scope === "client") {
      clientSetFlag(flag.catalogKey as ClientFlagKey, next);
    } else {
      assistantSetFlag(flag.catalogKey as AssistantFlagKey, next);
    }
  };

  return (
    <div className="flex items-start gap-3 py-3">
      <div className="shrink-0 pt-0.5">
        <Toggle
          checked={flag.value}
          onChange={handleToggle}
          aria-label={`${flag.label} is ${flag.value ? "on" : "off"}`}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-body-medium-default text-[var(--content-default)]">
            {flag.label}
          </span>
          <Tag tone="neutral">{flag.scope}</Tag>
        </div>
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
          <Tag tone="neutral">{flag.defaultValue ? "On" : "Off"}</Tag>
        </div>
      </div>
    </div>
  );
}
