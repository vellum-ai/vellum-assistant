
import { Check, Sparkles, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { BottomSheet } from "@vellum/design-library";
import { Button } from "@vellum/design-library";
import { Menu } from "@vellum/design-library";
import { PanelItem } from "@vellum/design-library";
import { client } from "@/generated/api/client.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  profilePickerLabel,
  visibleProfilesForPicker,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";
import {
  deleteConversationOverride,
  getConversationOverride,
  getGlobalThresholds,
  setConversationOverride,
  setGlobalThresholds,
} from "@/lib/threshold-api";
import {
  THRESHOLD_PRESETS,
  overrideAction,
  presetFromThreshold,
  type ThresholdPreset,
} from "@/utils/threshold-presets";

interface Props {
  assistantId: string;
  conversationId: string | undefined;
}

export function ComposerSettingsMenu({ assistantId, conversationId }: Props) {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activePreset, setActivePreset] = useState<ThresholdPreset>(THRESHOLD_PRESETS[1]!);
  // null until the global threshold loads — guards prevent acting on a stale
  // assumed default. Items render normally (matching macOS always-interactive
  // appearance); selection is gated until the real value is known.
  const [globalInteractive, setGlobalInteractive] = useState<string | null>(null);
  const [isOverride, setIsOverride] = useState(false);

  // Profile state
  const [profileActiveKey, setProfileActiveKey] = useState<string | null>(null);
  const [profileOrder, setProfileOrder] = useState<string[]>([]);
  const [profileMap, setProfileMap] = useState<Record<string, { label?: string | null; status?: "active" | "disabled" }>>({});
  // Global active profile from daemon config — used as fallback when there is
  // no per-conversation override, and as the target for no-conversation selects.
  const globalActiveProfileRef = useRef<string | null>(null);
  // Tracks the last value successfully confirmed by the server so rollback is
  // always to a known-good state rather than a stale closure capture.
  const lastConfirmedProfileRef = useRef<string | null>(null);
  // Ref (not state) — flipped to true once the first combined fetch resolves.
  // Used to guard handleProfileSelect without triggering extra renders.
  const profilesReadyRef = useRef(false);

  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (!assistantId) return;
    let cancelled = false;

    (async () => {
      try {
        const thresholds = await getGlobalThresholds(assistantId);
        if (cancelled) return;
        setGlobalInteractive(thresholds.interactive);

        if (!conversationId) {
          setActivePreset(presetFromThreshold(thresholds.interactive));
          setIsOverride(false);
          return;
        }

        const override = await getConversationOverride(assistantId, conversationId);
        if (cancelled) return;
        if (override !== null) {
          setActivePreset(presetFromThreshold(override));
          setIsOverride(true);
        } else {
          setActivePreset(presetFromThreshold(thresholds.interactive));
          setIsOverride(false);
        }
      } catch {
        if (cancelled) return;
      }
    })();

    return () => { cancelled = true; };
  }, [assistantId, conversationId]);

  // Fetch daemon config and conversation profile in parallel. Running both under
  // the same [assistantId, conversationId] dep set eliminates the two-effect
  // init race from prior cycles — state is always applied together after both
  // fetches settle, and re-running on assistantId change resets profilesReadyRef
  // before the async work starts (ref mutation, no extra render).
  useEffect(() => {
    if (!assistantId) return;
    profilesReadyRef.current = false;
    let cancelled = false;

    (async () => {
      try {
        const [configResult, convResult] = await Promise.allSettled([
          client.get<Record<string, unknown>, unknown>({
            url: `/v1/assistants/{assistant_id}/config`,
            path: { assistant_id: assistantId },
            throwOnError: false,
          }),
          conversationId
            ? client.get<Record<string, unknown>, unknown>({
                url: `/v1/assistants/{assistant_id}/conversations/{conversation_id}`,
                path: { assistant_id: assistantId, conversation_id: conversationId },
                throwOnError: false,
              })
            : Promise.resolve(null),
        ]);

        if (cancelled) return;

        // Extract global config — always apply profile list/map regardless of
        // whether the conversation fetch succeeded.
        let globalActive: string | null = null;
        if (configResult.status === "fulfilled" && configResult.value?.data) {
          const llm = (configResult.value.data as { llm?: Record<string, unknown> }).llm ?? {};
          const order = (llm.profileOrder as string[] | undefined) ?? [];
          const map = (llm.profiles as Record<string, { label?: string | null }> | undefined) ?? {};
          globalActive = (llm.activeProfile as string | null | undefined) ?? null;
          setProfileOrder(order);
          setProfileMap(map);
          globalActiveProfileRef.current = globalActive;
        }

        // Determine effective profile — per-conversation override wins over global.
        let effective: string | null = globalActive;
        if (convResult?.status === "fulfilled" && convResult.value !== null && convResult.value?.data) {
          const convData = convResult.value.data as Record<string, unknown>;
          const conv = (convData.conversation as Record<string, unknown> | undefined) ?? convData;
          const inferenceProfile = typeof conv.inferenceProfile === "string" ? conv.inferenceProfile : null;
          if (inferenceProfile !== null) {
            effective = inferenceProfile;
          }
        }

        setProfileActiveKey(effective);
        lastConfirmedProfileRef.current = effective;
        profilesReadyRef.current = true;
      } catch {
        if (cancelled) return;
      }
    })();

    return () => { cancelled = true; };
  }, [assistantId, conversationId]);

  const handleSelect = useCallback(
    async (preset: ThresholdPreset) => {
      // Don't act until the real global threshold has loaded — without this
      // guard a quick select uses a stale assumed default and miscomputes
      // overrideAction (e.g. clears an override when it should set one).
      if (globalInteractive === null) return;

      // Without an active conversation, update the assistant's global threshold
      // (matches macOS behavior of always allowing access-level changes).
      if (!conversationId) {
        const previousGlobal = globalInteractive;
        setActivePreset(preset);
        setGlobalInteractive(preset.riskThreshold);
        setIsOverride(false);
        try {
          await setGlobalThresholds(assistantId, { interactive: preset.riskThreshold });
        } catch {
          setActivePreset(presetFromThreshold(previousGlobal));
          setGlobalInteractive(previousGlobal);
        }
        return;
      }

      const action = overrideAction(preset, globalInteractive);
      setActivePreset(preset);
      setIsOverride(action.action === "set");

      try {
        if (action.action === "set") {
          await setConversationOverride(assistantId, conversationId, action.threshold);
        } else {
          await deleteConversationOverride(assistantId, conversationId);
        }
      } catch {
        if (conversationIdRef.current !== conversationId) return;
        const currentOverride = await getConversationOverride(assistantId, conversationId).catch(() => null);
        if (currentOverride !== null) {
          setActivePreset(presetFromThreshold(currentOverride));
          setIsOverride(true);
        } else {
          setActivePreset(presetFromThreshold(globalInteractive));
          setIsOverride(false);
        }
      }
    },
    [assistantId, conversationId, globalInteractive],
  );

  const handleProfileSelect = useCallback(
    async (name: string) => {
      // Guard against interaction before profiles are loaded — mirrors the
      // globalInteractive === null guard on handleSelect.
      if (!profilesReadyRef.current) return;
      // Capture conversationId at call time so post-async guards can verify the
      // user hasn't switched conversations while the request was in flight.
      const capturedConversationId = conversationIdRef.current;
      setProfileActiveKey(name);
      try {
        if (capturedConversationId) {
          // Per-conversation override — matches the threshold pattern.
          await client.put({
            url: `/v1/assistants/{assistant_id}/conversations/{conversation_id}/inference-profile`,
            path: { assistant_id: assistantId, conversation_id: capturedConversationId },
            body: { profile: name },
            headers: { "Content-Type": "application/json" },
            throwOnError: true,
          });
        } else {
          // No active conversation: update global active profile.
          await client.patch({
            url: `/v1/assistants/{assistant_id}/config`,
            path: { assistant_id: assistantId },
            body: { llm: { activeProfile: name } },
            headers: { "Content-Type": "application/json" },
            throwOnError: true,
          });
          globalActiveProfileRef.current = name;
        }
        // Guard: only apply success state if still on the same conversation.
        // A late success from a previous conversation must not overwrite the
        // newly loaded conversation's profile state.
        if (conversationIdRef.current === capturedConversationId) {
          lastConfirmedProfileRef.current = name;
          // Re-sync UI to confirmed server state in case a concurrent failure
          // rolled profileActiveKey back while this request was in flight.
          setProfileActiveKey(name);
        }
        // Invalidate cached active (provider, model) lookups for this
        // assistant so dependent UI (e.g. the composer's vision-capability
        // gate) reflects the new profile immediately instead of waiting
        // for staleTime to elapse. Predicate match covers both the global
        // (conversationId=null) and per-conversation cache entries.
        void queryClient.invalidateQueries({
          predicate: (query) => {
            const key = query.queryKey;
            return (
              Array.isArray(key) &&
              key[0] === "active-profile-model" &&
              key[1] === assistantId
            );
          },
        });
      } catch {
        if (conversationIdRef.current === capturedConversationId) {
          // Roll back to the last server-confirmed value, not a stale closure
          // capture — avoids clobbering a later successful selection when two
          // requests race (select A → select B → A fails → should stay at B).
          setProfileActiveKey(lastConfirmedProfileRef.current);
        }
      }
    },
    [assistantId, queryClient],
  );

  // Profiles in profileOrder first, then any extras present in profileMap but
  // absent from profileOrder (guards against partial/stale daemon config).
  // Disabled profiles are normally hidden from the picker, but the currently-
  // active one stays visible so the checkmark has somewhere to land.
  const orderedProfileEntries = useMemo<ProfilePickerEntry[]>(() => {
    const ordered = profileOrder
      .filter((name) => name in profileMap)
      .map((name) => ({ name, ...profileMap[name]! }));
    const extras = Object.keys(profileMap)
      .filter((name) => !profileOrder.includes(name))
      .map((name) => ({ name, ...profileMap[name]! }));
    return [...ordered, ...extras];
  }, [profileMap, profileOrder]);

  const visibleProfileEntries = useMemo(
    () => visibleProfilesForPicker(orderedProfileEntries, [profileActiveKey]),
    [orderedProfileEntries, profileActiveKey],
  );

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
                !isOverride && globalInteractive !== null && preset.riskThreshold === globalInteractive;
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
            {visibleProfileEntries.length > 0 && (
              <>
                <MenuDivider />
                <SectionLabel>Model Profile</SectionLabel>
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
              </>
            )}
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
            !isOverride && globalInteractive !== null && preset.riskThreshold === globalInteractive;
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
        {visibleProfileEntries.length > 0 && (
          <>
            <Menu.Separator />
            <Menu.Label className="text-label-small-default normal-case tracking-normal">
              Model Profile
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
          </>
        )}
      </Menu.Content>
    </Menu.Root>
  );
}

/** Bottom-sheet section label — small-caps style matching Menu.Label. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-[8px] py-1 text-label-small-default text-[var(--content-tertiary)]">
      {children}
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
