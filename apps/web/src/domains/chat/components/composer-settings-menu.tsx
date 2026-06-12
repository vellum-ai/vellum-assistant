import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, SlidersHorizontal, Sparkles } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
    gateAutoProfile,
    profilePickerLabel,
    visibleProfilesForPicker,
    type ProfilePickerEntry,
} from "@/assistant/profile-pickers";
import { useProfileQuickAdd } from "@/components/profile-quick-add-provider";
import {
    configGetOptions,
    configGetQueryKey,
    conversationsByIdGetOptions,
    conversationsByIdGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
    configPatch,
    conversationsByIdInferenceprofilePut,
} from "@/generated/daemon/sdk.gen";
import type { ConfigGetResponse } from "@/generated/daemon/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
    deleteConversationOverride,
    getConversationOverride,
    getGlobalThresholds,
    setConversationOverride,
    setGlobalThresholds,
} from "@/lib/threshold-api";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
    THRESHOLD_PRESETS,
    overrideAction,
    presetFromThreshold,
    type ThresholdPreset,
} from "@/utils/threshold-presets";
import { BottomSheet, Button, Menu, PanelItem, Tooltip } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";

interface Props {
  assistantId: string;
  conversationId: string | undefined;
}

export function ComposerSettingsMenu({ assistantId, conversationId }: Props) {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  // ---------------------------------------------------------------------------
  // Server-state queries — replace the old useEffect + async IIFE pattern.
  // Each query shares its TanStack Query cache entry with the rest of the app.
  // ---------------------------------------------------------------------------

  const configQuery = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  const conversationQuery = useQuery({
    ...conversationsByIdGetOptions({
      path: { assistant_id: assistantId, id: conversationId ?? "" },
    }),
    enabled: !!assistantId && !!conversationId,
  });

  const globalThresholdsQuery = useQuery({
    queryKey: ["globalThresholds", assistantId],
    queryFn: () => getGlobalThresholds(assistantId),
    enabled: !!assistantId,
    staleTime: 30_000,
  });

  const conversationThresholdQuery = useQuery({
    queryKey: ["conversationThresholdOverride", assistantId, conversationId],
    queryFn: () => getConversationOverride(assistantId, conversationId!),
    enabled: !!assistantId && !!conversationId,
  });

  // ---------------------------------------------------------------------------
  // Derived server data — read from query cache, no useState copies.
  // ---------------------------------------------------------------------------

  type Profiles = NonNullable<NonNullable<ConfigGetResponse["llm"]>["profiles"]>;
  const profiles = useMemo<Profiles>(
    () => configQuery.data?.llm?.profiles ?? {},
    [configQuery.data],
  );
  const profileOrder = useMemo<string[]>(
    () => configQuery.data?.llm?.profileOrder ?? [],
    [configQuery.data],
  );
  const globalActiveProfile = configQuery.data?.llm?.activeProfile ?? null;
  const conversationProfileOverride =
    conversationQuery.data?.conversation.inferenceProfile ?? null;
  const serverEffectiveProfile = conversationProfileOverride ?? globalActiveProfile;
  const profilesLoaded = configQuery.isSuccess;

  const serverGlobalInteractive =
    globalThresholdsQuery.data?.interactive ?? null;
  const serverThresholdOverride = conversationThresholdQuery.data ?? null;
  const serverActivePreset = useMemo<ThresholdPreset>(() => {
    if (serverThresholdOverride !== null) {
      return presetFromThreshold(serverThresholdOverride);
    }
    if (serverGlobalInteractive !== null) {
      return presetFromThreshold(serverGlobalInteractive);
    }
    return THRESHOLD_PRESETS[1]!;
  }, [serverThresholdOverride, serverGlobalInteractive]);
  const serverIsOverride = serverThresholdOverride !== null;

  // ---------------------------------------------------------------------------
  // Optimistic state — only for values that diverge from server truth during
  // in-flight mutations. null = no pending mutation, display server value.
  // ---------------------------------------------------------------------------

  const [optimisticPreset, setOptimisticPreset] = useState<ThresholdPreset | null>(null);
  const [optimisticIsOverride, setOptimisticIsOverride] = useState<boolean | null>(null);
  const activePreset = optimisticPreset ?? serverActivePreset;
  const isOverride = optimisticIsOverride ?? serverIsOverride;

  const [optimisticActiveProfile, setOptimisticActiveProfile] = useState<string | null>(null);
  const lastConfirmedProfileRef = useRef<string | null>(null);
  const profileActiveKey = optimisticActiveProfile ?? serverEffectiveProfile;

  // Reset optimistic state on conversation change — the old optimistic values
  // belong to a different conversation context. Uses useLayoutEffect so the
  // stale values are cleared before paint (no flash of previous conversation's
  // optimistic state).
  useLayoutEffect(() => {
    setOptimisticActiveProfile(null);
    setOptimisticPreset(null);
    setOptimisticIsOverride(null);
    lastConfirmedProfileRef.current = null;
  }, [conversationId]);

  // Track confirmed server-effective profile for mutation rollback. Only update
  // when no optimistic mutation is in flight — otherwise the confirmed ref must
  // retain the last known-good value, not the mutation target.
  useEffect(() => {
    if (configQuery.isSuccess && optimisticActiveProfile === null) {
      lastConfirmedProfileRef.current = serverEffectiveProfile;
    }
  }, [configQuery.isSuccess, optimisticActiveProfile, serverEffectiveProfile]);

  // Stable ref for conversationId — used by async mutation callbacks to guard
  // against late results when the user has already switched conversations.
  const conversationIdRef = useRef(conversationId);
  useLayoutEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // ---------------------------------------------------------------------------
  // Threshold mutation handler
  // ---------------------------------------------------------------------------

  const handleSelect = useCallback(
    async (preset: ThresholdPreset) => {
      // Don't act until the real global threshold has loaded.
      if (serverGlobalInteractive === null) return;

      setOptimisticPreset(preset);

      if (!conversationId) {
        // Update assistant's global threshold (matches macOS behavior).
        setOptimisticIsOverride(false);
        try {
          await setGlobalThresholds(assistantId, { interactive: preset.riskThreshold });
          void queryClient.invalidateQueries({
            queryKey: ["globalThresholds", assistantId],
          });
        } catch {
          // Rollback: clear optimistic state to fall back to server values.
        }
        setOptimisticPreset(null);
        setOptimisticIsOverride(null);
        return;
      }

      const action = overrideAction(preset, serverGlobalInteractive);
      setOptimisticIsOverride(action.action === "set");

      try {
        if (action.action === "set") {
          await setConversationOverride(assistantId, conversationId, action.threshold);
        } else {
          await deleteConversationOverride(assistantId, conversationId);
        }
        void queryClient.invalidateQueries({
          queryKey: ["conversationThresholdOverride", assistantId, conversationId],
        });
      } catch {
        if (conversationIdRef.current !== conversationId) return;
        // Re-fetch the server state to display the actual value.
        void queryClient.invalidateQueries({
          queryKey: ["conversationThresholdOverride", assistantId, conversationId],
        });
      }
      setOptimisticPreset(null);
      setOptimisticIsOverride(null);
    },
    [assistantId, conversationId, serverGlobalInteractive, queryClient],
  );

  // ---------------------------------------------------------------------------
  // Profile selection mutation handler
  // ---------------------------------------------------------------------------

  const handleProfileSelect = useCallback(
    async (name: string): Promise<boolean> => {
      if (!configQuery.isSuccess) return false;
      const capturedConversationId = conversationIdRef.current;
      setOptimisticActiveProfile(name);
      try {
        if (capturedConversationId) {
          await conversationsByIdInferenceprofilePut({
            path: { assistant_id: assistantId, id: capturedConversationId },
            body: { profile: name },
            throwOnError: true,
          });
        } else {
          await configPatch({
            path: { assistant_id: assistantId },
            body: { llm: { activeProfile: name } },
            throwOnError: true,
          });
        }
        if (conversationIdRef.current === capturedConversationId) {
          lastConfirmedProfileRef.current = name;
        }
        // Invalidate shared caches so all consumers refresh.
        const configKey = configGetQueryKey({ path: { assistant_id: assistantId } });
        void queryClient.invalidateQueries({ queryKey: configKey }).then(() => {
          // Clear optimistic only after refetch settles — avoids flash of stale value.
          setOptimisticActiveProfile((current) =>
            current === name ? null : current,
          );
        });
        if (capturedConversationId) {
          void queryClient.invalidateQueries({
            queryKey: conversationsByIdGetQueryKey({
              path: { assistant_id: assistantId, id: capturedConversationId },
            }),
          });
        }
        return true;
      } catch {
        if (conversationIdRef.current === capturedConversationId) {
          // Roll back to the last server-confirmed value, not a stale closure
          // capture — avoids clobbering a later successful selection when two
          // requests race (select A → select B → A fails → should stay at B).
          setOptimisticActiveProfile(lastConfirmedProfileRef.current);
          toast.error("Failed to switch profile. Please try again.");
        }
        return false;
      }
    },
    [assistantId, configQuery.isSuccess, queryClient],
  );

  // ---------------------------------------------------------------------------
  // Derived profile picker data
  // ---------------------------------------------------------------------------

  const orderedProfileEntries = useMemo<ProfilePickerEntry[]>(() => {
    const ordered = profileOrder
      .filter((name) => name in profiles)
      .map((name) => ({ name, ...profiles[name]! }));
    const extras = Object.keys(profiles)
      .filter((name) => !profileOrder.includes(name))
      .map((name) => ({ name, ...profiles[name]! }));
    return [...ordered, ...extras];
  }, [profiles, profileOrder]);

  const queryComplexityRoutingEnabled =
    useAssistantFeatureFlagStore.use.queryComplexityRouting();

  const visibleProfileEntries = useMemo(
    () =>
      gateAutoProfile(
        visibleProfilesForPicker(orderedProfileEntries, [profileActiveKey]),
        queryComplexityRoutingEnabled,
      ),
    [orderedProfileEntries, profileActiveKey, queryComplexityRoutingEnabled],
  );

  // Quick-add is owned by the top-level ProfileQuickAddProvider (chat must not
  // import settings directly — see local/no-cross-domain-imports). The provider
  // renders the ProfileEditorModal in create mode, persists the new profile,
  // and toasts; we hand it the current profile names and an onCreated callback
  // so the new profile is autoselected for this thread once it persists.
  const { openProfileQuickAdd } = useProfileQuickAdd();

  const existingProfileNames = useMemo(
    () => Array.from(new Set([...profileOrder, ...Object.keys(profiles)])),
    [profileOrder, profiles],
  );

  // The "+" quick-add affordance rendered in both the desktop Menu.Label and
  // the mobile SectionLabel. Closes the popover/sheet, then opens the modal.
  // Disabled until `profilesLoaded` — opening the modal with empty profile
  // data would let a duplicate name overwrite an existing profile.
  const quickAddButton = (
    <Tooltip
      content={profilesLoaded ? "New Profile" : "Loading profiles…"}
      side="top"
    >
      <Button
        variant="ghost"
        size="compact"
        iconOnly={<Plus className="h-3.5 w-3.5" />}
        aria-label="New Profile"
        disabled={!profilesLoaded}
        aria-disabled={!profilesLoaded}
        onClick={() => {
          if (!profilesLoaded) return;
          setOpen(false);
          openProfileQuickAdd({
            existingNames: existingProfileNames,
            onCreated: (name, label) => {
              // Optimistically add the profile to the shared config cache so
              // the picker renders it immediately (all consumers see the update).
              const configKey = configGetQueryKey({ path: { assistant_id: assistantId } });
              queryClient.setQueryData<ConfigGetResponse>(configKey, (old) => {
                if (!old) return old;
                const currentOrder = old.llm?.profileOrder ?? [];
                return {
                  ...old,
                  llm: {
                    ...old.llm,
                    profiles: { ...old.llm?.profiles, [name]: { label } },
                    profileOrder: currentOrder.includes(name)
                      ? currentOrder
                      : [...currentOrder, name],
                  },
                };
              });
              // Don't invalidate here — the background refetch could race with
              // the creation and overwrite the optimistic entry. The profile
              // selection below invalidates on success, which is the right
              // reconciliation point (by then the server has the profile).
              void handleProfileSelect(name).then((selected) => {
                if (!selected) {
                  toast.error("Profile created, but couldn't switch to it");
                }
              });
            },
          });
        }}
      />
    </Tooltip>
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const trigger = (
    <Button
      variant="ghost"
      iconOnly={<SlidersHorizontal className="h-[18px] w-[18px]" />}
      aria-label="Conversation settings"
      className="[--vbtn-fg:var(--content-secondary)] data-[state=open]:[--vbtn-fg:var(--content-default)]"
    />
  );

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        {/* Radix Dialog requires a Title for screen-reader accessibility;
            no visible title in the Figma surface, so render a visually-
            hidden one (matches BottomSheet.gallery.tsx → "NoTitle"). */}
        <BottomSheet.Content aria-describedby={undefined}>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>Conversation settings</BottomSheet.Title>
          </BottomSheet.Header>
          {/* Wrap in Body so a long profile list scrolls when the sheet
              hits its 50dvh cap. `pt-0` because the Header is sr-only. */}
          <BottomSheet.Body className="pt-0">
            <SectionLabel>Assistant Access</SectionLabel>
            {THRESHOLD_PRESETS.map((preset) => {
              const isActive = preset.id === activePreset.id;
              const isDefault =
                !isOverride && serverGlobalInteractive !== null && preset.riskThreshold === serverGlobalInteractive;
              return (
                <PanelItem
                  key={preset.id}
                  icon={preset.icon}
                  label={isDefault ? `${preset.label} (default)` : preset.label}
                  active={isActive}
                  trailingAction={
                    isActive ? (
                      <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
                    ) : undefined
                  }
                  onSelect={() => {
                    handleSelect(preset);
                    setOpen(false);
                  }}
                />
              );
            })}
            <MenuDivider />
            <SectionLabel trailingAction={quickAddButton}>
              Model Profile
            </SectionLabel>
            {visibleProfileEntries.map((entry) => {
              const isActive = entry.name === profileActiveKey;
              return (
                <PanelItem
                  key={entry.name}
                  icon={Sparkles}
                  label={profilePickerLabel(entry)}
                  active={isActive}
                  trailingAction={
                    isActive ? (
                      <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
                    ) : undefined
                  }
                  onSelect={() => {
                    handleProfileSelect(entry.name);
                    setOpen(false);
                  }}
                />
              );
            })}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Content side="top" align="start">
        <Menu.Label className="text-label-small-default normal-case tracking-normal">
          Assistant Access
        </Menu.Label>
        {THRESHOLD_PRESETS.map((preset) => {
          const isActive = preset.id === activePreset.id;
          const PresetIcon = preset.icon;
          const isDefault =
            !isOverride && serverGlobalInteractive !== null && preset.riskThreshold === serverGlobalInteractive;
          return (
            <Menu.Item
              key={preset.id}
              onSelect={() => handleSelect(preset)}
              leftIcon={<PresetIcon className="h-3.5 w-3.5" />}
              className={isActive ? "bg-[var(--surface-active)] text-[var(--content-emphasised)]" : ""}
              shortcut={isActive ? <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" /> : undefined}
              title={preset.description}
            >
              {preset.label}
              {isDefault && (
                <span className="ml-1 text-[var(--content-tertiary)]">(default)</span>
              )}
            </Menu.Item>
          );
        })}
        <Menu.Separator />
        <Menu.Label className="flex items-center justify-between gap-2 text-label-small-default normal-case tracking-normal">
          <span>Model Profile</span>
          {quickAddButton}
        </Menu.Label>
        {visibleProfileEntries.map((entry) => {
          const isActive = entry.name === profileActiveKey;
          return (
            <Menu.Item
              key={entry.name}
              onSelect={() => handleProfileSelect(entry.name)}
              leftIcon={<Sparkles className="h-3.5 w-3.5" />}
              className={isActive ? "bg-[var(--surface-active)] text-[var(--content-emphasised)]" : ""}
              shortcut={isActive ? <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" /> : undefined}
              title={entry.name === "auto" ? "Automatically switches profiles based on the query" : undefined}
            >
              {profilePickerLabel(entry)}
            </Menu.Item>
          );
        })}
      </Menu.Content>
    </Menu.Root>
  );
}

/** Bottom-sheet section label — small-caps style matching Menu.Label. */
function SectionLabel({
  children,
  trailingAction,
}: {
  children: ReactNode;
  trailingAction?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-[8px] pt-2.5 pb-2 text-body-small-default text-[var(--content-tertiary)]">
      <span>{children}</span>
      {trailingAction}
    </div>
  );
}

/** 1px divider with 4px breathing room above and below. */
function MenuDivider() {
  return (
    <div
      aria-hidden="true"
      className="my-1 h-px"
      style={{ background: "var(--border-overlay)" }}
    />
  );
}
