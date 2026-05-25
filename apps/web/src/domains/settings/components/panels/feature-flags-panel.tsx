import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Tag, type TagTone } from "@vellum/design-library/components/tag";
import { Toggle } from "@vellum/design-library/components/toggle";
import { SettingsCard } from "@/domains/settings/components/settings-card.js";
import { assistantsActiveRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store.js";
import { useAssistantFeatureFlagStore } from "@/lib/feature-flags/assistant-feature-flag-store.js";
import {
  ALL_FLAGS,
  flagKeyToStoreKey,
  scopeIncludes,
  type FlagScope,
  type SingleScope,
} from "@/lib/feature-flags/feature-flag-catalog.js";
import { useFlagQueryFreshness } from "@/lib/backwards-compat/flag-query-freshness.js";
import {
  assistantFlagValuesQueryKey,
  fetchAssistantFlagValues,
} from "@/lib/feature-flags/use-assistant-feature-flag-sync.js";

const SCOPE_TONE: Record<SingleScope, TagTone> = {
  client: "warning",
  assistant: "positive",
};

interface FlagDisplayEntry {
  storeKey: string;
  scope: FlagScope;
  label: string;
  description: string;
  value: boolean;
  defaultValue: boolean;
}

export function FeatureFlagsPanel() {
  const { data: activeAssistant } = useQuery(assistantsActiveRetrieveOptions());
  const assistantId = activeAssistant?.id ?? null;

  // Same-key observer: TanStack dedups with `useAssistantFeatureFlagSync`'s
  // root-level query. Kept so the panel stays live while toggling on
  // older daemons; on push-capable daemons this resolves to a no-op
  // (`refetchInterval: false`).
  const freshness = useFlagQueryFreshness();
  useQuery({
    queryKey: assistantFlagValuesQueryKey(assistantId),
    queryFn: () => fetchAssistantFlagValues(assistantId!),
    enabled: assistantId !== null,
    ...freshness,
    retry: 1,
  });

  const [searchText, setSearchText] = useState("");
  const clientState = useClientFeatureFlagStore();
  const assistantState = useAssistantFeatureFlagStore();

  const flags: FlagDisplayEntry[] = useMemo(() => {
    const entries: FlagDisplayEntry[] = [];
    for (const flag of ALL_FLAGS) {
      const storeKey = flagKeyToStoreKey(flag.key);
      const clientVal = clientState[storeKey];
      const assistantVal = assistantState[storeKey];
      const value =
        flag.scope === "both"
          ? clientVal === true || assistantVal === true
          : flag.scope === "assistant"
            ? assistantVal
            : clientVal;
      if (typeof value !== "boolean") continue;
      entries.push({
        storeKey,
        scope: flag.scope as FlagScope,
        label: flag.label,
        description: flag.description,
        value,
        defaultValue: flag.defaultEnabled,
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
        flag.storeKey.toLowerCase().includes(query) ||
        flag.scope.includes(query) ||
        (flag.scope === "both" &&
          ("client".includes(query) || "assistant".includes(query))),
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
              <FeatureFlagRow
                key={flag.storeKey}
                flag={flag}
                assistantId={assistantId}
              />
            ))}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

interface FeatureFlagRowProps {
  flag: FlagDisplayEntry;
  /**
   * Active assistant id for PATCH'ing assistant-scoped overrides.
   * `null` while the active-assistant query is still in-flight; toggle
   * is still functional client-side, the server PATCH is just skipped.
   */
  assistantId: string | null;
}

function ScopeChips({ scope }: { scope: FlagScope }) {
  if (scope === "both") {
    return (
      <>
        <Tag tone={SCOPE_TONE.client}>client</Tag>
        <Tag tone={SCOPE_TONE.assistant}>assistant</Tag>
      </>
    );
  }
  return <Tag tone={SCOPE_TONE[scope]}>{scope}</Tag>;
}

function FeatureFlagRow({ flag, assistantId }: FeatureFlagRowProps) {
  const clientSetFlag = useClientFeatureFlagStore.use.setFlag();
  const assistantSetFlag = useAssistantFeatureFlagStore.use.setFlag();

  const handleToggle = (next: boolean) => {
    if (scopeIncludes(flag.scope, "client")) {
      clientSetFlag(flag.storeKey, next);
    }
    if (scopeIncludes(flag.scope, "assistant")) {
      assistantSetFlag(flag.storeKey, next, assistantId);
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
          <ScopeChips scope={flag.scope} />
        </div>
        <span className="block text-body-small-default text-[var(--content-tertiary)]">
          {flag.description}
        </span>
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
