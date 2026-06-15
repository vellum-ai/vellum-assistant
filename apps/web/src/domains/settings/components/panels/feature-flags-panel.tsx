import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
import { client } from "@/generated/api/client.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
    ALL_FLAGS,
    flagKeyToStoreKey,
    scopeIncludes,
    type FlagScope,
    type SingleScope,
} from "@/lib/feature-flags/feature-flag-catalog";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { cn } from "@vellumai/design-library";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

interface FlagDefinitionResponse {
  key: string;
  type: "boolean" | "string";
  values?: string[];
}

async function fetchFlagDefinitions(): Promise<FlagDefinitionResponse[]> {
  const { data, response } = await client.get<
    { flags: FlagDefinitionResponse[] },
    Record<string, unknown>,
    false
  >({ url: "/v1/feature-flags/", throwOnError: false });
  if (!response?.ok) return [];
  const parsed = data as { flags?: FlagDefinitionResponse[] } | undefined;
  return parsed?.flags ?? [];
}

const SCOPE_TONE: Record<SingleScope, TagTone> = {
  client: "warning",
  assistant: "positive",
};

type FlagDisplayEntry =
  | {
      kind: "boolean";
      storeKey: string;
      scope: FlagScope;
      label: string;
      description: string;
      value: boolean;
      defaultValue: boolean;
    }
  | {
      kind: "string";
      storeKey: string;
      scope: FlagScope;
      label: string;
      description: string;
      value: string;
      defaultValue: string;
      values?: string[];
    };

export function FeatureFlagsPanel() {
  // The panel renders under `ActiveAssistantGate` (routes.tsx), which defers
  // child rendering until an assistant is resolved — so the id is always
  // available here. Reading it from the resolved-assistants store (via
  // `useActiveAssistantId`) rather than the platform `assistants/active` query
  // is what makes assistant-scoped flag PATCHes work in local mode, where the
  // platform query has no id and the write was silently dropped. Live flag
  // updates are owned by the root-level `useAssistantFeatureFlagSync`.
  const assistantId = useActiveAssistantId();

  const isOrgReady = useIsOrgReady();
  const { data: definitions } = useQuery({
    queryKey: ["feature-flag-definitions"],
    queryFn: fetchFlagDefinitions,
    enabled: isOrgReady,
    staleTime: 5 * 60 * 1000,
  });

  const valuesMap = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!definitions) return map;
    for (const def of definitions) {
      if (def.type === "string" && def.values?.length) {
        map.set(def.key, def.values);
      }
    }
    return map;
  }, [definitions]);

  const [searchText, setSearchText] = useState("");
  const clientState = useClientFeatureFlagStore();
  const assistantState = useAssistantFeatureFlagStore();

  const flags: FlagDisplayEntry[] = useMemo(() => {
    const entries: FlagDisplayEntry[] = [];
    for (const flag of ALL_FLAGS) {
      const storeKey = flagKeyToStoreKey(flag.key);

      if (typeof flag.defaultEnabled === "boolean") {
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
          kind: "boolean",
          storeKey,
          scope: flag.scope as FlagScope,
          label: flag.label,
          description: flag.description,
          value,
          defaultValue: flag.defaultEnabled,
        });
      } else if (typeof flag.defaultEnabled === "string") {
        const clientStr = clientState.stringFlags?.[storeKey];
        const assistantStr = assistantState.stringFlags?.[storeKey];
        const value =
          flag.scope === "assistant"
            ? (assistantStr ?? flag.defaultEnabled)
            : (clientStr ?? flag.defaultEnabled);
        entries.push({
          kind: "string",
          storeKey,
          scope: flag.scope as FlagScope,
          label: flag.label,
          description: flag.description,
          value,
          defaultValue: flag.defaultEnabled,
          values: valuesMap.get(flag.key) ?? flag.values,
        });
      }
    }
    return entries.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
  }, [clientState, assistantState, valuesMap]);

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
    <DetailCard
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
            className="w-full rounded-lg border border-[var(--border-base)] bg-[var(--surface-default)] py-2 pl-9 pr-3 text-body-medium-default text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:border-[var(--border-focus)] focus:outline-none"
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
    </DetailCard>
  );
}

interface FeatureFlagRowProps {
  flag: FlagDisplayEntry;
  /** Active assistant id for PATCH'ing assistant-scoped overrides. */
  assistantId: string;
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

function BooleanFlagRow({
  flag,
  assistantId,
}: {
  flag: Extract<FlagDisplayEntry, { kind: "boolean" }>;
  assistantId: string;
}) {
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

function StringFlagRow({
  flag,
  assistantId,
}: {
  flag: Extract<FlagDisplayEntry, { kind: "string" }>;
  assistantId: string;
}) {
  const clientSetStringFlag = useClientFeatureFlagStore.use.setStringFlag();
  const assistantSetStringFlag = useAssistantFeatureFlagStore.use.setStringFlag();
  const [localValue, setLocalValue] = useState(flag.value);

  useEffect(() => {
    setLocalValue(flag.value);
  }, [flag.value]);

  const commitValue = (next: string) => {
    if (next === flag.value) return;
    if (scopeIncludes(flag.scope, "client")) {
      clientSetStringFlag(flag.storeKey, next);
    }
    if (scopeIncludes(flag.scope, "assistant")) {
      assistantSetStringFlag(flag.storeKey, next, assistantId);
    }
  };

  const isDirty = localValue !== flag.value;
  const knownValues = flag.values && flag.values.length > 0 ? flag.values : null;
  const isInvalid = isDirty && knownValues != null && !knownValues.includes(localValue);

  const handleBlur = () => {
    if (!isInvalid) commitValue(localValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  };

  const hasDropdown = knownValues != null && knownValues.includes(flag.value);

  return (
    <div className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-body-medium-default text-[var(--content-default)]">
            {flag.label}
          </span>
          <ScopeChips scope={flag.scope} />
        </div>
        <span className="block text-body-small-default text-[var(--content-tertiary)]">
          {flag.description}
        </span>
        {hasDropdown ? (
          <Dropdown
            value={flag.value}
            onChange={(next) => {
              setLocalValue(next);
              commitValue(next);
            }}
            options={knownValues.map((v) => ({ value: v, label: v }))}
            className="w-48"
            aria-label={`${flag.label} value`}
          />
        ) : (
          <div className="space-y-1">
            <input
              type="text"
              value={localValue}
              onChange={(e) => setLocalValue(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              className={cn(
                "w-full rounded-lg border bg-[var(--surface-default)] px-3 py-1.5 text-body-small-default text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:outline-none",
                isInvalid
                  ? "border-[var(--system-negative-strong)]"
                  : "border-[var(--border-base)] focus:border-[var(--border-focus)]",
              )}
              placeholder={flag.defaultValue || "Enter value..."}
            />
            {isInvalid && (
              <span className="block text-body-small-default text-[var(--system-negative-strong)]">
                Expected one of: {knownValues!.join(", ")}
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-1">
          <span className="text-body-small-default text-[var(--content-tertiary)]">
            Default:
          </span>
          <Tag tone="neutral">{flag.defaultValue || "(empty)"}</Tag>
        </div>
      </div>
    </div>
  );
}

function FeatureFlagRow({ flag, assistantId }: FeatureFlagRowProps) {
  if (flag.kind === "string") {
    return <StringFlagRow flag={flag} assistantId={assistantId} />;
  }
  return <BooleanFlagRow flag={flag} assistantId={assistantId} />;
}
