import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Menu as HamburgerIcon,
  Plus,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { t, useTranslation } from "@/i18n";
import { useSupportsCompleteProfileSnapshots } from "@/lib/backwards-compat/complete-profile-snapshots";
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
import { useComposerCompact } from "@/domains/chat/components/chat-composer/composer-compact";
import { preventPressFocusTransfer } from "@/domains/chat/components/chat-composer/composer-mobile-chrome";
import {
  clearComposerPillAccessPreset,
  clearComposerPillProfileLabel,
  saveComposerPillAccessPreset,
  saveComposerPillProfileLabel,
  useComposerPillSnapshot,
} from "@/domains/chat/utils/composer-pill-storage";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import {
  deleteConversationOverride,
  getConversationOverride,
  getGlobalThresholds,
  setConversationOverride,
  setGlobalThresholds,
} from "@/lib/threshold-api";
import { useConversationStore } from "@/stores/conversation-store";
import { badRequestMessage } from "@/utils/api-errors";
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
  ScrollShadow,
  Tooltip,
} from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";

interface Props {
  assistantId: string;
  conversationId: string | undefined;
  /**
   * Which trigger segment(s) this instance renders. The composer's action
   * row splits them across its two ends (Figma: New-App 7471-25234 —
   * access on the left beside the attach button, model profile on the
   * right beside the mic), mounting one instance per side. Server state
   * is TanStack-Query-cached, so the two instances share fetches.
   *
   * Ignored when the surrounding composer is compact: the row then holds a
   * single instance whose hamburger menu carries both sections.
   */
  segments?: "both" | "access" | "profile";
  /**
   * Called with whether any of this instance's surfaces is open, the quick-add
   * modal included. A parent that positions the triggers itself uses it to hold
   * that surface visible while focus sits inside the drawer's portal.
   */
  onOpenChange?: (open: boolean) => void;
}

export function ComposerSettingsMenu({
  assistantId,
  conversationId,
  segments = "both",
  onOpenChange,
}: Props) {
  const isMobile = useIsMobile();
  const isTouchMobile = useTouchMobile();
  const { t: tChat } = useTranslation("chat");
  // A composer too narrow for two labelled triggers folds both segments into
  // one hamburger menu. The composer mounts a single instance in that mode
  // (see `ChatComposer`'s action row), so `segments` is ignored here: the one
  // menu holds both sections.
  const compact = useComposerCompact() && !isMobile;
  const queryClient = useQueryClient();
  // Two independent menus/triggers — the access-level segment and the model-
  // profile segment each open their own popover so only the clicked segment
  // highlights and each surface shows a single, focused list.
  const [accessOpen, setAccessOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  // The quick-add modal is rendered by the top-level provider, outside this
  // component's tree, and opening it closes the surface it was launched from.
  // This flag stands in for that surface until the modal reports back, so a
  // parent holding the trigger row visible keeps it up for the whole flow
  // instead of pulling it away the moment focus moves into the modal.
  const [quickAddOpen, setQuickAddOpen] = useState(false);

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

  // What the pills displayed the last time these fetches settled, read during
  // render so a relaunch paints both of them in the first frame. Display only:
  // it never feeds a mutation. See `composer-pill-storage`.
  const pillSnapshot = useComposerPillSnapshot(assistantId);
  const seededPreset = useMemo(
    () =>
      THRESHOLD_PRESETS.find((p) => p.id === pillSnapshot.accessPresetId) ??
      null,
    [pillSnapshot.accessPresetId],
  );

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
    // `THRESHOLD_PRESETS[1]` is stricter than the server's own no-row default,
    // so it is only ever a placeholder for a pill the gate below keeps hidden.
    return seededPreset ?? THRESHOLD_PRESETS[1]!;
  }, [serverThresholdOverride, serverGlobalInteractive, seededPreset]);
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
  // remount and matches what the first message / promotion will apply. A
  // defined prop can also carry a stash: a draft stub's id (no server row
  // yet), or a loaded row whose promotion hasn't landed. In both cases the
  // stash is the latest intent, so it wins there too. See
  // `pendingDraftProfiles` in `conversation-store`.
  const activeConversationId = useConversationStore.use.activeConversationId();
  const pendingDraftProfiles = useConversationStore.use.pendingDraftProfiles();
  const stashKey = conversationId ?? activeConversationId;
  const draftProfileSelection = stashKey
    ? (pendingDraftProfiles.get(stashKey) ?? null)
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
  // Keyed by conversation id, holding the in-flight promotion promise so a
  // direct selection can serialize behind it (see handleProfileSelect). The
  // promise never rejects — failures are swallowed below.
  const promotingProfileRef = useRef<Map<string, Promise<void>>>(new Map());
  useEffect(() => {
    if (!conversationId) {
      return;
    }
    const stashed = pendingDraftProfiles.get(conversationId);
    if (stashed === undefined) {
      return;
    }
    if (findConversation(queryClient, assistantId, conversationId)?.draft) {
      return;
    }
    if (promotingProfileRef.current.has(conversationId)) {
      return;
    }
    const id = conversationId;
    const promotion = (async () => {
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
    promotingProfileRef.current.set(id, promotion);
  }, [conversationId, assistantId, pendingDraftProfiles, queryClient]);

  // ---------------------------------------------------------------------------
  // Threshold mutation handler
  // ---------------------------------------------------------------------------

  const handleSelect = useCallback(
    async (preset: ThresholdPreset) => {
      // Don't act until the real global threshold has loaded. `accessLive`
      // gates the surfaces on this same condition, so nothing reaches here
      // while it holds; keep the two in step.
      if (serverGlobalInteractive === null) {
        return;
      }

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
        if (conversationIdRef.current !== conversationId) {
          return;
        }
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
      if (!configQuery.isSuccess) {
        return false;
      }
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

      // A draft stub (optimistically prepended on first send, `draft: true`)
      // has no server row yet — a PUT against its client-minted id 404s
      // (ATL-1136). Stash like the no-row branch above; the send path forwards
      // the stash, and `use-send-message` re-keys it to the server-minted id
      // so the promotion effect persists it once the real row exists.
      if (
        findConversation(queryClient, assistantId, capturedConversationId)
          ?.draft
      ) {
        useConversationStore
          .getState()
          .setPendingDraftProfile(capturedConversationId, name);
        lastConfirmedProfileRef.current = name;
        return true;
      }

      // A direct selection supersedes any stash recorded for this conversation
      // while it was loading — drop it so an in-flight promotion can't write the
      // older value back (the promotion also re-checks the stash before
      // finalizing, so a not-yet-started one simply never fires).
      useConversationStore
        .getState()
        .clearPendingDraftProfile(capturedConversationId);

      // Serialize behind an in-flight promotion PUT for this conversation:
      // if the older promotion write landed after ours, the persisted
      // override would silently revert to the stashed value. The promotion
      // promise never rejects, so awaiting it is safe.
      const inflightPromotion = promotingProfileRef.current.get(
        capturedConversationId,
      );
      if (inflightPromotion) {
        await inflightPromotion;
      }

      try {
        await conversationsByIdInferenceprofilePut({
          path: { assistant_id: assistantId, id: capturedConversationId },
          body: { profile: name },
          throwOnError: true,
        });
        if (conversationIdRef.current === capturedConversationId) {
          lastConfirmedProfileRef.current = name;
        }
        const configKey = configGetQueryKey({
          path: { assistant_id: assistantId },
        });
        void queryClient.invalidateQueries({ queryKey: configKey });
        void queryClient
          .invalidateQueries({
            queryKey: conversationsByIdGetQueryKey({
              path: { assistant_id: assistantId, id: capturedConversationId },
            }),
          })
          .then(() => {
            setOptimisticActiveProfile((current) =>
              current === name ? null : current,
            );
          });
        return true;
      } catch (error) {
        if (conversationIdRef.current === capturedConversationId) {
          // Roll back to the last server-confirmed value, not a stale closure
          // capture — avoids clobbering a later successful selection when two
          // requests race (select A → select B → A fails → should stay at B).
          setOptimisticActiveProfile(lastConfirmedProfileRef.current);
          // A 400 means the profile can't dispatch (no connection or key for
          // its provider). The server names what's missing; generic retry copy
          // would send the user round the same failing loop.
          toast.error(
            badRequestMessage(error) ??
              t("chat:composerSettingsMenu.profileSwitchFallback"),
          );
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

  // Older assistants live-inherit blank profile fields at resolution time,
  // so a sparse profile dispatches there and must not be hidden.
  const requireOwnProviderAndModel = useSupportsCompleteProfileSnapshots();
  const visibleProfileEntries = useMemo(
    () =>
      visibleProfilesForPicker(orderedProfileEntries, [profileActiveKey], {
        requireOwnProviderAndModel,
      }),
    [orderedProfileEntries, profileActiveKey, requireOwnProviderAndModel],
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

  // The label the trigger renders. Until the config fetch settles it stands in
  // with the last launch's, which is the assistant's own default profile and so
  // right for every conversation that doesn't override it; the rest reconcile
  // silently when the fetch lands. Once config has answered (or failed), its
  // answer is the only one, so a profile that was renamed, removed, or is
  // simply unreachable can't linger behind a label.
  const displayProfileLabel =
    activeProfileLabel ??
    (profilesLoaded || configQuery.isError ? null : pillSnapshot.profileLabel);

  // Record what each pill settled on for the next launch. Keyed off the global
  // values, not the per-conversation effective ones, so a conversation-scoped
  // override can't become the seed every other conversation opens with.
  useEffect(() => {
    if (serverGlobalInteractive === null) {
      return;
    }
    // Only an exact match: `presetFromThreshold` answers with the conservative
    // preset for a threshold it doesn't recognize, and freezing that into the
    // seed would show a stricter level than the server holds for as long as the
    // two sides disagree about the vocabulary. An answer this build cannot name
    // also invalidates whatever the seed held: repainting the old preset on
    // every launch is the same skew, one launch removed, so the field clears
    // instead. A null answer proves nothing and leaves the seed alone.
    const preset = THRESHOLD_PRESETS.find(
      (p) => p.riskThreshold === serverGlobalInteractive,
    );
    if (!preset) {
      clearComposerPillAccessPreset(assistantId);
      return;
    }
    saveComposerPillAccessPreset(assistantId, preset.id);
  }, [assistantId, serverGlobalInteractive]);

  // Resolved here rather than in the effect below: `orderedProfileEntries` is a
  // fresh array whenever the daemon omits `profileOrder`, and an effect keyed on
  // it would hit storage on every render of a component the chat view mounts
  // twice.
  const globalProfileLabel = useMemo(() => {
    if (!globalActiveProfile) {
      return null;
    }
    const entry = orderedProfileEntries.find(
      (e) => e.name === globalActiveProfile,
    );
    return entry ? profilePickerLabel(entry) : null;
  }, [globalActiveProfile, orderedProfileEntries]);

  useEffect(() => {
    // Before the config settles, a null label proves nothing and the seed
    // stays. After a successful response it is the server's answer: no active
    // profile, or one this map cannot name, invalidates whatever the seed
    // held, the same way an unnameable threshold clears the access field.
    if (!profilesLoaded) {
      return;
    }
    if (globalProfileLabel === null) {
      clearComposerPillProfileLabel(assistantId);
      return;
    }
    saveComposerPillProfileLabel(assistantId, globalProfileLabel);
  }, [assistantId, profilesLoaded, globalProfileLabel]);

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
  const quickAddControl = (
    <Button
      variant="ghost"
      size="compact"
      iconOnly={<Plus className="h-3.5 w-3.5" />}
      aria-label={tChat("composerSettingsMenu.quickAdd")}
      disabled={!profilesLoaded}
      aria-disabled={!profilesLoaded}
      onClick={() => {
        if (!profilesLoaded) {
          return;
        }
        setProfileOpen(false);
        setCompactOpen(false);
        // Claimed after the open call, not before: taking the modal over
        // releases whoever held it, and that release must not land on top of
        // this claim.
        openProfileQuickAdd({
          existingNames: existingProfileNames,
          onClosed: () => setQuickAddOpen(false),
          onCreated: (name, _label) => {
            // ProfileQuickAddProvider already wrote the full PATCH response
            // (merged config including the new profile's provider/model/etc.)
            // to the shared config query cache via configGetSetQueryData.
            // No cache write needed here, just autoselect the new profile.
            void handleProfileSelect(name).then((selected) => {
              if (!selected) {
                toast.error(t("chat:composerSettingsMenu.profileSwitchFailed"));
              }
            });
          },
        });
        setQuickAddOpen(true);
      }}
    />
  );

  // The tooltip is a hover affordance, so the touch presentation goes without
  // it. Radix opens a tooltip on focus as well as hover, and the bottom sheet
  // autofocuses its first tabbable element, which is this button: on a phone
  // the label appeared unbidden every time the sheet rose, clipped against the
  // right edge of the screen. The button's `aria-label` carries the same words,
  // so nothing is lost by dropping it here.
  const quickAddButton = isTouchMobile ? (
    quickAddControl
  ) : (
    <Tooltip
      content={
        profilesLoaded
          ? tChat("composerSettingsMenu.quickAdd")
          : tChat("composerSettingsMenu.loadingProfiles")
      }
      side="top"
    >
      {quickAddControl}
    </Tooltip>
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Access-level segment. Two gates, because displaying a level and changing
  // one need different things to have happened:
  //
  // `accessLive` is the global threshold, and is the exact condition
  // `handleSelect` refuses to act without: it compares against that value to
  // decide between setting a per-conversation override and clearing one. A
  // conversation override does not stand in for it, so an override that
  // resolves first must not open the picker.
  //
  // `accessSettled` accepts anything the server actually returned: the global
  // value, an override for this conversation, or a preset stored on a previous
  // launch. Enough to show a level, never enough to act on, so the trigger
  // renders inert rather than taking presses it would drop in silence. The
  // stored preset stops counting once the fetch has failed outright, so a
  // level nothing can confirm doesn't sit there for the rest of the session.
  //
  // None of them accepts the `THRESHOLD_PRESETS[1]` fallback, which is stricter
  // than the server's own default and so must never reach the screen.
  const AccessIcon = activePreset.icon;
  const accessLive = serverGlobalInteractive !== null;
  const accessSettled =
    accessLive ||
    serverIsOverride ||
    (seededPreset !== null && !globalThresholdsQuery.isError);
  const showAccess = accessSettled && segments !== "profile";
  const showProfile = segments !== "access";

  // Only the branch this render mounts can hold an open surface: the compact
  // hamburger owns `compactOpen`, the split layout owns whichever of
  // access/profile it renders. Crossing the compact width (or losing a segment)
  // unmounts the open branch without React clearing its flag, so the report
  // below reads the mounted branch only.
  const anySurfaceOpen = compact
    ? compactOpen
    : (showAccess && accessOpen) || (showProfile && profileOpen);
  const anyDrawerOpen = anySurfaceOpen || quickAddOpen;

  // Clear the flags the mounted branch doesn't own, so crossing back doesn't
  // reopen a surface the user left behind at the old width.
  useEffect(() => {
    if (compact || !showAccess) {
      setAccessOpen(false);
    }
    if (compact || !showProfile) {
      setProfileOpen(false);
    }
    if (!compact) {
      setCompactOpen(false);
    }
  }, [compact, showAccess, showProfile]);

  // The flags are set from several places (trigger, row selection, quick add),
  // so the notification reads the settled value once instead of being threaded
  // through every setter. Calling through the ref keeps it a transition
  // callback like the Radix one it mirrors: the effect runs on an open-state
  // change alone, so a parent passing an inline closure can't re-run it, and
  // the drawers start closed.
  const notifiedOpenRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  useEffect(() => {
    if (notifiedOpenRef.current === anyDrawerOpen) {
      return;
    }
    notifiedOpenRef.current = anyDrawerOpen;
    onOpenChangeRef.current?.(anyDrawerOpen);
  }, [anyDrawerOpen]);

  // Unmounting is the last chance to report. Swapping presentation (a phone
  // rotating into the desktop layout) tears this instance down mid-open, and a
  // parent left holding `true` would keep a surface up that nothing can close.
  useEffect(() => {
    return () => {
      if (!notifiedOpenRef.current) {
        return;
      }
      notifiedOpenRef.current = false;
      onOpenChangeRef.current?.(false);
    };
  }, []);

  // Each trigger is the design library's ghost Button — same chrome and
  // sizing as the row's other icon buttons (attach, mic) — in the action
  // row's tertiary resting tone, held open-highlighted while its own menu
  // is up.
  const triggerClass =
    "[--vbtn-fg:var(--content-tertiary)] touch-mobile:[--vbtn-fg:var(--content-tertiary)] data-[state=open]:bg-[color-mix(in_srgb,var(--primary-second-hover)_15%,transparent)]";
  const triggerLabelClass = "gap-1.5 px-1.5 text-body-small-default";

  // Mobile floats both triggers above the composer card as filled pills, so
  // they carry their own fill: the action row's transparent ghost chrome would
  // leave them unreadable against the chat background. The fill is the same
  // token the add-to-chat sheet's icon circles use (Figma 7840-8818).
  const pillBaseClass =
    "h-8 rounded-full bg-[var(--border-subtle)] text-body-small-default [--vbtn-fg:var(--content-secondary)] hover:bg-[var(--surface-active)] active:bg-[var(--surface-active)] data-[state=open]:bg-[var(--surface-active)]";
  const pillClass = `${pillBaseClass} min-w-0 pl-1.5 pr-2`;
  // Icon-only pills keep the labelled pill's height and shape so the row's
  // geometry survives a trigger whose label hasn't resolved. `px-1.5` is the
  // design's 6px inset around the glyph, which fills the 32px box exactly.
  const pillIconOnlyClass = `${pillBaseClass} w-8 px-1.5`;
  // The pills carry a 20px glyph (Figma 7840-8818), wider than the Button's
  // own icon box, so the glyph rides as a child instead. The Button's
  // `gap-1.5` then supplies the design's 6px between glyph and label.
  const pillIconClass =
    "flex size-5 shrink-0 items-center justify-center text-[var(--content-tertiary)] [&_svg]:size-5";

  // A trigger showing a stored level before its fetch lands is inert, not
  // spent: it names the level it holds at full contrast, and only stops
  // answering presses. The Button's own disabled treatment dims the label to
  // `--content-disabled`, which would make the thing it exists to show the
  // hardest part of it to read, so both tones are restored here.
  const inertTriggerClass =
    "disabled:cursor-default disabled:[--vbtn-fg:var(--content-secondary)]";
  const inertActionRowTriggerClass =
    "disabled:cursor-default disabled:[--vbtn-fg:var(--content-tertiary)]";

  // Access trigger: the active preset's name beside its icon, as a floating
  // pill on mobile (Figma 7840-8819) and as an action-row button on desktop
  // (Figma 7471-25243).
  const accessLabel = tChat("composerSettingsMenu.accessAria", {
    label: activePreset.label,
  });
  const accessTrigger = isMobile ? (
    <Button
      variant="ghost"
      aria-label={accessLabel}
      title={accessLabel}
      className={`${pillClass} ${inertTriggerClass}`}
      disabled={!accessLive}
      // Touch only: the bottom sheet opens on the click that follows, so the
      // press has to leave the composer's focus alone until then.
      onMouseDown={isTouchMobile ? preventPressFocusTransfer : undefined}
    >
      <span aria-hidden="true" className={pillIconClass}>
        <AccessIcon />
      </span>
      {activePreset.label}
    </Button>
  ) : (
    <Button
      variant="ghost"
      leftIcon={<AccessIcon className="h-3.5 w-3.5 shrink-0" />}
      aria-label={accessLabel}
      title={accessLabel}
      className={`${triggerClass} ${triggerLabelClass} ${inertActionRowTriggerClass} shrink-0`}
      disabled={!accessLive}
    >
      {activePreset.label}
    </Button>
  );

  // Profile trigger: Sparkles plus the active profile's name, matching the
  // access trigger's shape on each presentation. Until that name resolves it
  // falls back to the sliders icon alone, so there is always an affordance to
  // open the picker with.
  // `profileLabel` is the accessible name on every variant, mirroring
  // `accessLabel`: an aria-label overrides the visible text, so it has to carry
  // the selection a labelled trigger shows, or the name says nothing about it
  // and voice control can't reach the control by what it reads.
  const profileLabel = displayProfileLabel
    ? tChat("composerSettingsMenu.profileAria", {
        label: displayProfileLabel,
      })
    : tChat("composerSettingsMenu.profileAriaFallback");
  // min-w-0 + truncate keeps a long label from pushing the composer's action
  // buttons off-screen on narrow viewports. leading-snug: text-body-small-default
  // is line-height:1, so truncate clips descenders (e.g. the "g" in profile
  // names). The fade carries a first-run label into a trigger that started
  // without one, so it arrives rather than pops.
  const profileLabelText = (
    <span className="max-w-[10rem] animate-[fadeIn_var(--anim-fast)_var(--anim-ease-out)] truncate leading-snug motion-reduce:animate-none">
      {displayProfileLabel}
    </span>
  );
  // One Button across both states so the label arriving is a change inside a
  // live element rather than a swap of one element for another: the fade below
  // only plays because the pill it lands in is the same node.
  const profileTrigger = isMobile ? (
    <Button
      variant="ghost"
      aria-label={profileLabel}
      title={profileLabel}
      className={displayProfileLabel ? pillClass : pillIconOnlyClass}
      // Match the access pill: hold the composer's focus for the sheet's
      // click, and only on the touch presentation that opens that way.
      onMouseDown={isTouchMobile ? preventPressFocusTransfer : undefined}
    >
      <span aria-hidden="true" className={pillIconClass}>
        {displayProfileLabel ? <Sparkles /> : <SlidersHorizontal />}
      </span>
      {displayProfileLabel ? profileLabelText : null}
    </Button>
  ) : displayProfileLabel ? (
    <Button
      variant="ghost"
      leftIcon={<Sparkles className="h-3.5 w-3.5 shrink-0" />}
      aria-label={profileLabel}
      title={profileLabel}
      className={`${triggerClass} ${triggerLabelClass} min-w-0`}
    >
      {profileLabelText}
    </Button>
  ) : (
    <Button
      variant="ghost"
      iconOnly={<SlidersHorizontal />}
      aria-label={profileLabel}
      title={profileLabel}
      className={triggerClass}
    />
  );

  const accessItems = THRESHOLD_PRESETS.map((preset) => ({
    preset,
    isActive: preset.id === activePreset.id,
    isDefault:
      !isOverride &&
      serverGlobalInteractive !== null &&
      preset.riskThreshold === serverGlobalInteractive,
  }));

  // Menu rows, shared by the split desktop menus and the compact hamburger so
  // the two layouts can never drift apart.
  const accessMenuItems = accessItems.map(({ preset, isActive, isDefault }) => {
    const PresetIcon = preset.icon;
    return (
      <Menu.Item
        key={preset.id}
        onSelect={() => handleSelect(preset)}
        // Inert for the same reason the trigger is: the compact hamburger
        // reaches these rows without passing through it.
        disabled={!accessLive}
        leftIcon={<PresetIcon className="h-3.5 w-3.5" />}
        className={
          isActive
            ? "bg-[var(--surface-active)] text-[var(--content-emphasised)]"
            : ""
        }
        trailing={
          isActive ? (
            <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
          ) : undefined
        }
        title={preset.description}
      >
        {preset.label}
        {isDefault && (
          <span className="ml-1 text-[var(--content-tertiary)]">
            {tChat("composerSettingsMenu.defaultSuffix")}
          </span>
        )}
      </Menu.Item>
    );
  });

  const profileMenuItems = visibleProfileEntries.map((entry) => {
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
        trailing={
          isActive ? (
            <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
          ) : undefined
        }
      >
        {profilePickerLabel(entry)}
      </Menu.Item>
    );
  });

  // The profile list grows with the workspace and the menu has no ceiling of
  // its own, so a long one runs off the top of the composer. Cap it at about
  // seven rows and scroll the rest, with the design library's edge fade
  // signalling that there is more below. Radix keeps the focused row in view
  // as the arrow keys walk past the cap.
  const profileMenuList = (
    <ScrollShadow className="max-h-[13rem]" size={16}>
      {profileMenuItems}
    </ScrollShadow>
  );

  const menuLabelClass =
    "mb-1 text-label-small-default normal-case tracking-normal";
  const profileMenuLabel = (
    <Menu.Label
      className={`${menuLabelClass} flex items-center justify-between gap-2`}
    >
      <span>{tChat("composerSettingsMenu.modelProfile")}</span>
      {/* The compact quick-add button (h-6/24px) is taller than the label
          text's own line box (10px); items-center would otherwise stretch the
          row to fit it and nudge the text down relative to the icon-less
          Assistant Access label. Cancel that out so both labels sit at the
          same offset. */}
      <span className="-my-[7px]">{quickAddButton}</span>
    </Menu.Label>
  );

  if (compact) {
    // One trigger, one menu, both sections, so the row keeps its
    // attach | settings | mic | voice order and nothing collides. The access
    // section waits on a value the server returned (same gate as `showAccess`)
    // so it never flashes the fallback preset, and its rows stay inert until
    // the real one lands; the trigger itself is always mounted, so the profile
    // section below it is reachable either way.
    const activeSummary = [
      accessSettled ? activePreset.label : null,
      displayProfileLabel,
    ]
      .filter(Boolean)
      .join(" · ");
    const compactLabel = tChat("composerSettingsMenu.compactAria");
    return (
      <Menu.Root open={compactOpen} onOpenChange={setCompactOpen}>
        <Menu.Trigger asChild>
          <Button
            variant="ghost"
            iconOnly={<HamburgerIcon />}
            aria-label={compactLabel}
            title={
              activeSummary
                ? tChat("composerSettingsMenu.compactAriaWithSummary", {
                    summary: activeSummary,
                  })
                : compactLabel
            }
            className={triggerClass}
          />
        </Menu.Trigger>
        <Menu.Content side="top" align="start">
          {accessSettled && (
            <>
              <Menu.Label className={menuLabelClass}>
                {tChat("composerSettingsMenu.assistantAccess")}
              </Menu.Label>
              {accessMenuItems}
              <Menu.Separator />
            </>
          )}
          {profileMenuLabel}
          {profileMenuList}
        </Menu.Content>
      </Menu.Root>
    );
  }

  if (isTouchMobile) {
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
                <BottomSheet.Title>
                  {tChat("composerSettingsMenu.assistantAccessTitle")}
                </BottomSheet.Title>
              </BottomSheet.Header>
              <BottomSheet.Body className="pt-0">
                <SectionLabel>
                  {tChat("composerSettingsMenu.assistantAccess")}
                </SectionLabel>
                {accessItems.map(({ preset, isActive, isDefault }) => (
                  <PanelItem
                    key={preset.id}
                    icon={preset.icon}
                    label={
                      isDefault
                        ? tChat("composerSettingsMenu.defaultLabel", {
                            label: preset.label,
                          })
                        : preset.label
                    }
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
        {showProfile && (
          <BottomSheet.Root open={profileOpen} onOpenChange={setProfileOpen}>
            <BottomSheet.Trigger asChild>{profileTrigger}</BottomSheet.Trigger>
            <BottomSheet.Content aria-describedby={undefined}>
              <BottomSheet.Header className="sr-only">
                <BottomSheet.Title>
                  {tChat("composerSettingsMenu.modelProfileTitle")}
                </BottomSheet.Title>
              </BottomSheet.Header>
              {/* Wrap in Body so a long profile list scrolls when the sheet
                hits its 50dvh cap. `pt-0` because the Header is sr-only. */}
              <BottomSheet.Body className="pt-0">
                <SectionLabel trailingAction={quickAddButton}>
                  {tChat("composerSettingsMenu.modelProfile")}
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
        )}
      </>
    );
  }

  return (
    <>
      {showAccess && (
        <Menu.Root open={accessOpen} onOpenChange={setAccessOpen}>
          <Menu.Trigger asChild>{accessTrigger}</Menu.Trigger>
          <Menu.Content side="top" align="start">
            <Menu.Label className={menuLabelClass}>
              {tChat("composerSettingsMenu.assistantAccess")}
            </Menu.Label>
            {accessMenuItems}
          </Menu.Content>
        </Menu.Root>
      )}
      {showProfile && (
        <Menu.Root open={profileOpen} onOpenChange={setProfileOpen}>
          <Menu.Trigger asChild>{profileTrigger}</Menu.Trigger>
          <Menu.Content side="top" align="start">
            {profileMenuLabel}
            {profileMenuList}
          </Menu.Content>
        </Menu.Root>
      )}
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
