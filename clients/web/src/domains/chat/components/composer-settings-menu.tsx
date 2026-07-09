import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, SlidersHorizontal, Sparkles } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  profilePickerLabel,
  visibleProfilesForPicker,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";
import { useStickyProfiles } from "@/assistant/use-sticky-profiles";
import { useProfileQuickAdd } from "@/components/profile-quick-add-provider";
import {
  configGetOptions,
  configGetQueryKey,
  conversationsByIdGetOptions,
  conversationsByIdGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { conversationsByIdInferenceprofilePut } from "@/generated/daemon/sdk.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  deleteConversationOverride,
  getConversationOverride,
  getGlobalThresholds,
  setConversationOverride,
  setGlobalThresholds,
} from "@/lib/threshold-api";
import { useConversationStore } from "@/stores/conversation-store";
import { findConversation } from "@/utils/conversation-cache";
import {
  THRESHOLD_PRESETS,
  overrideAction,
  presetFromThreshold,
  type ThresholdPreset,
} from "@/utils/threshold-presets";
import {
  BottomSheet,
  Button,
  Menu,
  PanelItem,
  Tooltip,
} from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";

interface Props {
  assistantId: string;
  conversationId: string | undefined;
}

export function ComposerSettingsMenu({ assistantId, conversationId }: Props) {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  // Two independent menus/triggers — the access-level segment and the model-
  // profile segment each open their own popover so only the clicked segment
  // highlights and each surface shows a single, focused list.
  const [accessOpen, setAccessOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

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

  // Retain the last non-empty profile list so a transient empty config payload
  // (e.g. a partial read while the daemon rewrites settings.json) can't blank
  // the picker until the next good fetch — managed profiles are always seeded,
  // so an empty profile map is never a legitimate steady state.
  const { profiles, profileOrder } = useStickyProfiles(
    configQuery.data?.llm,
    assistantId,
  );
  const globalActiveProfile = configQuery.data?.llm?.activeProfile ?? null;
  const conversationProfileOverride =
    conversationQuery.data?.conversation.inferenceProfile ?? null;
  const serverEffectiveProfile =
    conversationProfileOverride ?? globalActiveProfile;
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

  const [optimisticPreset, setOptimisticPreset] =
    useState<ThresholdPreset | null>(null);
  const [optimisticIsOverride, setOptimisticIsOverride] = useState<
    boolean | null
  >(null);
  const activePreset = optimisticPreset ?? serverActivePreset;
  const isOverride = optimisticIsOverride ?? serverIsOverride;

  const [optimisticActiveProfile, setOptimisticActiveProfile] = useState<
    string | null
  >(null);
  const lastConfirmedProfileRef = useRef<string | null>(null);

  // When a row isn't loaded yet the menu's `conversationId` prop is undefined
  // while the real/draft id lives in the conversation store. If the user
  // already picked a model for that id, the selection is stashed there (not
  // written to the global default) — reflect it so the checkmark survives a
  // remount and matches what the first message / promotion will apply. See
  // `pendingDraftProfiles` in `conversation-store`.
  const activeConversationId = useConversationStore.use.activeConversationId();
  const pendingDraftProfiles = useConversationStore.use.pendingDraftProfiles();
  const draftProfileSelection =
    !conversationId && activeConversationId
      ? (pendingDraftProfiles.get(activeConversationId) ?? null)
      : null;

  const profileActiveKey =
    optimisticActiveProfile ?? draftProfileSelection ?? serverEffectiveProfile;

  // Reset optimistic state on conversation change — the old optimistic values
  // belong to a different conversation context. Uses useLayoutEffect so the
  // stale values are cleared before paint (no flash of previous conversation's
  // optimistic state). Also keys on `activeConversationId` so switching between
  // two unsent drafts (both have an undefined `conversationId` prop) still
  // clears the prior draft's optimistic checkmark.
  useLayoutEffect(() => {
    setOptimisticActiveProfile(null);
    setOptimisticPreset(null);
    setOptimisticIsOverride(null);
    lastConfirmedProfileRef.current = null;
  }, [conversationId, activeConversationId]);

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

  // Promote a stash that was recorded while this conversation's row was still
  // loading. An existing conversation opened by URL/deep link has an undefined
  // `conversationId` prop until its row resolves, so a profile picked in that
  // window gets stashed (handleProfileSelect can't yet tell it apart from a
  // draft). Once the row loads we know it's a real server conversation, so
  // persist the stash as a per-conversation override. Draft stubs (`draft:
  // true`, added optimistically on first send) are skipped — the send path owns
  // their stash and applies it to the conversation it mints.
  const promotingProfileRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!conversationId) return;
    const stashed = pendingDraftProfiles.get(conversationId);
    if (stashed === undefined) return;
    if (findConversation(queryClient, assistantId, conversationId)?.draft)
      return;
    if (promotingProfileRef.current.has(conversationId)) return;
    const id = conversationId;
    promotingProfileRef.current.add(id);
    void (async () => {
      try {
        await conversationsByIdInferenceprofilePut({
          path: { assistant_id: assistantId, id },
          body: { profile: stashed },
          throwOnError: true,
        });
        // Finalize only if this promotion is still the latest intent for `id`.
        // A direct selection made meanwhile clears/replaces the stash and owns
        // the cache update, so a late promotion must not write its stale value
        // back or re-invalidate.
        if (
          useConversationStore.getState().pendingDraftProfiles.get(id) ===
          stashed
        ) {
          useConversationStore.getState().clearPendingDraftProfile(id);
          void queryClient.invalidateQueries({
            queryKey: conversationsByIdGetQueryKey({
              path: { assistant_id: assistantId, id },
            }),
          });
        }
      } catch {
        // Leave the stash so a later interaction can retry; a toast here would
        // be noisy during navigation/load.
      } finally {
        promotingProfileRef.current.delete(id);
      }
    })();
  }, [conversationId, assistantId, pendingDraftProfiles, queryClient]);

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
          await setGlobalThresholds(assistantId, {
            interactive: preset.riskThreshold,
          });
          void queryClient
            .invalidateQueries({
              queryKey: ["globalThresholds", assistantId],
            })
            .then(() => {
              setOptimisticPreset(null);
              setOptimisticIsOverride(null);
            });
        } catch {
          // Rollback: clear optimistic state to fall back to server values.
          setOptimisticPreset(null);
          setOptimisticIsOverride(null);
        }
        return;
      }

      const action = overrideAction(preset, serverGlobalInteractive);
      setOptimisticIsOverride(action.action === "set");

      try {
        if (action.action === "set") {
          await setConversationOverride(
            assistantId,
            conversationId,
            action.threshold,
          );
        } else {
          await deleteConversationOverride(assistantId, conversationId);
        }
        void queryClient
          .invalidateQueries({
            queryKey: [
              "conversationThresholdOverride",
              assistantId,
              conversationId,
            ],
          })
          .then(() => {
            setOptimisticPreset(null);
            setOptimisticIsOverride(null);
          });
      } catch {
        if (conversationIdRef.current !== conversationId) return;
        // Re-fetch the server state to display the actual value.
        void queryClient.invalidateQueries({
          queryKey: [
            "conversationThresholdOverride",
            assistantId,
            conversationId,
          ],
        });
        setOptimisticPreset(null);
        setOptimisticIsOverride(null);
      }
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

      // No loaded row yet — a brand-new draft, or an existing conversation
      // still loading. Stash the selection keyed by the active id instead of
      // overwriting the global default profile (the value the Settings "default
      // profile" control owns). It is applied by the send path when a draft's
      // first message mints the conversation, or promoted to a per-conversation
      // override by the effect above once a real row loads. No network call and
      // no rollback — the optimistic/stashed value stands until then.
      if (!capturedConversationId) {
        const targetConversationId =
          useConversationStore.getState().activeConversationId;
        if (targetConversationId) {
          useConversationStore
            .getState()
            .setPendingDraftProfile(targetConversationId, name);
          lastConfirmedProfileRef.current = name;
          return true;
        }
        // Nothing to attach the selection to (no active id) — revert the
        // optimistic checkmark rather than leave it stranded.
        setOptimisticActiveProfile(lastConfirmedProfileRef.current);
        return false;
      }

      // A direct selection supersedes any stash recorded for this conversation
      // while it was loading — drop it so an in-flight promotion can't write the
      // older value back (the promotion also re-checks the stash before
      // finalizing, so a not-yet-started one simply never fires).
      useConversationStore
        .getState()
        .clearPendingDraftProfile(capturedConversationId);

      try {
        await conversationsByIdInferenceprofilePut({
          path: { assistant_id: assistantId, id: capturedConversationId },
          body: { profile: name },
          throwOnError: true,
        });
        if (conversationIdRef.current === capturedConversationId) {
          lastConfirmedProfileRef.current = name;
        }
        // Invalidate shared caches so all consumers refresh.
        const configKey = configGetQueryKey({
          path: { assistant_id: assistantId },
        });
        void queryClient.invalidateQueries({ queryKey: configKey }).then(() => {
          // Clear optimistic only after refetch settles — avoids flash of stale value.
          setOptimisticActiveProfile((current) =>
            current === name ? null : current,
          );
        });
        void queryClient.invalidateQueries({
          queryKey: conversationsByIdGetQueryKey({
            path: { assistant_id: assistantId, id: capturedConversationId },
          }),
        });
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

  const visibleProfileEntries = useMemo(
    () => visibleProfilesForPicker(orderedProfileEntries, [profileActiveKey]),
    [orderedProfileEntries, profileActiveKey],
  );

  // Label for the currently-active profile, shown inline on the composer
  // trigger so a power user can see which profile a conversation runs on
  // without opening the menu.
  const activeProfileLabel = useMemo(() => {
    if (!profileActiveKey) {
      return null;
    }
    const entry = orderedProfileEntries.find(
      (e) => e.name === profileActiveKey,
    );
    return entry ? profilePickerLabel(entry) : null;
  }, [orderedProfileEntries, profileActiveKey]);

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
          setProfileOpen(false);
          openProfileQuickAdd({
            existingNames: existingProfileNames,
            onCreated: (name, _label) => {
              // ProfileQuickAddProvider already wrote the full PATCH response
              // (merged config including the new profile's provider/model/etc.)
              // to the shared config query cache via configGetSetQueryData.
              // No cache write needed here — just autoselect the new profile.
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

  // Access-level segment: gate on a settled fetch (or an active override) so the
  // trigger never flashes the `THRESHOLD_PRESETS[1]` fallback before the real
  // value loads. Only the icon is shown inline — the label lives in a tooltip
  // and the menu — to keep the composer's bottom bar compact.
  const AccessIcon = activePreset.icon;
  const showAccess = globalThresholdsQuery.isSuccess || serverIsOverride;

  // Each trigger is a self-contained button: highlights on hover and while its
  // own menu is open, independent of the sibling trigger.
  const triggerClass =
    "flex h-7 items-center gap-1.5 rounded-md px-1.5 py-1 text-body-small-default text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)] data-[state=open]:bg-[var(--surface-active)] data-[state=open]:text-[var(--content-default)]";

  // Access trigger — icon only. Sits between the context-window ring and the
  // model-profile trigger. `title` surfaces the active preset name since the
  // label is no longer shown inline.
  const accessTrigger = (
    <button
      type="button"
      aria-label={`Assistant access: ${activePreset.label}`}
      title={`Assistant access: ${activePreset.label}`}
      className={`${triggerClass} shrink-0`}
    >
      <AccessIcon className="h-3.5 w-3.5 shrink-0" />
    </button>
  );

  // Profile trigger — Sparkles + label. Falls back to the sliders icon until
  // the active profile resolves so there's always an affordance to open it.
  const profileTrigger = (
    <button
      type="button"
      aria-label="Model profile"
      className={`${triggerClass} min-w-0`}
    >
      {activeProfileLabel ? (
        <>
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          {/* min-w-0 + truncate keeps a long label from pushing the composer's
              action buttons off-screen on narrow viewports; the cap is tighter
              on mobile where the bottom bar has the least room. */}
          <span className="max-w-[7rem] truncate sm:max-w-[10rem]">
            {activeProfileLabel}
          </span>
        </>
      ) : (
        <SlidersHorizontal className="h-[18px] w-[18px]" />
      )}
    </button>
  );

  const accessItems = THRESHOLD_PRESETS.map((preset) => ({
    preset,
    isActive: preset.id === activePreset.id,
    isDefault:
      !isOverride &&
      serverGlobalInteractive !== null &&
      preset.riskThreshold === serverGlobalInteractive,
  }));

  if (isMobile) {
    return (
      <>
        {showAccess && (
          <BottomSheet.Root open={accessOpen} onOpenChange={setAccessOpen}>
            <BottomSheet.Trigger asChild>{accessTrigger}</BottomSheet.Trigger>
            {/* Radix Dialog requires a Title for screen-reader accessibility;
                no visible title in the Figma surface, so render a visually-
                hidden one (matches BottomSheet.gallery.tsx → "NoTitle"). */}
            <BottomSheet.Content aria-describedby={undefined}>
              <BottomSheet.Header className="sr-only">
                <BottomSheet.Title>Assistant access</BottomSheet.Title>
              </BottomSheet.Header>
              <BottomSheet.Body className="pt-0">
                <SectionLabel>Assistant Access</SectionLabel>
                {accessItems.map(({ preset, isActive, isDefault }) => (
                  <PanelItem
                    key={preset.id}
                    icon={preset.icon}
                    label={isDefault ? `${preset.label} (default)` : preset.label}
                    active={isActive}
                    className="max-md:[&>span:first-child]:gap-[11px]"
                    trailingAction={
                      isActive ? (
                        <Check className="h-4 w-4 text-[var(--system-positive-strong)]" />
                      ) : undefined
                    }
                    onSelect={() => {
                      handleSelect(preset);
                      setAccessOpen(false);
                    }}
                  />
                ))}
              </BottomSheet.Body>
            </BottomSheet.Content>
          </BottomSheet.Root>
        )}
        <BottomSheet.Root open={profileOpen} onOpenChange={setProfileOpen}>
          <BottomSheet.Trigger asChild>{profileTrigger}</BottomSheet.Trigger>
          <BottomSheet.Content aria-describedby={undefined}>
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>Model profile</BottomSheet.Title>
            </BottomSheet.Header>
            {/* Wrap in Body so a long profile list scrolls when the sheet
                hits its 50dvh cap. `pt-0` because the Header is sr-only. */}
            <BottomSheet.Body className="pt-0">
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
                    className="max-md:[&>span:first-child]:gap-[11px]"
                    trailingAction={
                      isActive ? (
                        <Check className="h-4 w-4 text-[var(--system-positive-strong)]" />
                      ) : undefined
                    }
                    onSelect={() => {
                      handleProfileSelect(entry.name);
                      setProfileOpen(false);
                    }}
                  />
                );
              })}
            </BottomSheet.Body>
          </BottomSheet.Content>
        </BottomSheet.Root>
      </>
    );
  }

  return (
    <>
      {showAccess && (
        <Menu.Root open={accessOpen} onOpenChange={setAccessOpen}>
          <Menu.Trigger asChild>{accessTrigger}</Menu.Trigger>
          <Menu.Content side="top" align="start">
            <Menu.Label className="text-label-small-default normal-case tracking-normal">
              Assistant Access
            </Menu.Label>
            {accessItems.map(({ preset, isActive, isDefault }) => {
              const PresetIcon = preset.icon;
              return (
                <Menu.Item
                  key={preset.id}
                  onSelect={() => handleSelect(preset)}
                  leftIcon={<PresetIcon className="h-3.5 w-3.5" />}
                  className={
                    isActive
                      ? "bg-[var(--surface-active)] text-[var(--content-emphasised)]"
                      : ""
                  }
                  shortcut={
                    isActive ? (
                      <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
                    ) : undefined
                  }
                  title={preset.description}
                >
                  {preset.label}
                  {isDefault && (
                    <span className="ml-1 text-[var(--content-tertiary)]">
                      (default)
                    </span>
                  )}
                </Menu.Item>
              );
            })}
          </Menu.Content>
        </Menu.Root>
      )}
      <Menu.Root open={profileOpen} onOpenChange={setProfileOpen}>
        <Menu.Trigger asChild>{profileTrigger}</Menu.Trigger>
        <Menu.Content side="top" align="start">
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
                className={
                  isActive
                    ? "bg-[var(--surface-active)] text-[var(--content-emphasised)]"
                    : ""
                }
                shortcut={
                  isActive ? (
                    <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
                  ) : undefined
                }
              >
                {profilePickerLabel(entry)}
              </Menu.Item>
            );
          })}
        </Menu.Content>
      </Menu.Root>
    </>
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
      {trailingAction ? <span className="-mr-2">{trailingAction}</span> : null}
    </div>
  );
}
