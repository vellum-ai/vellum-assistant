/**
 * App-level controller for the profile quick-add ("+ New Profile") flow.
 *
 * Chat's `ComposerSettingsMenu` must not import from `@/domains/settings/...`
 * (enforced by `local/no-cross-domain-imports`). This provider lifts the
 * settings-owned `ProfileEditorModal` create flow up to the top level, where
 * importing settings is allowed, and exposes an imperative opener via the
 * `useProfileQuickAdd()` hook. The composer calls `openProfileQuickAdd({...})`
 * and receives the newly-created profile name back through an `onCreated`
 * callback so it can run its existing autoselect logic in chat context.
 *
 * The controller owns everything settings-specific the composer previously
 * inlined: the `ProfileEditorModal` render (create mode), the provider-
 * connections query that feeds its Provider picker, the existing-name list,
 * the feature-flag props, the create-persistence config PATCH (byte-identical
 * to `ManageProfilesModal`'s create path), and the success toast.
 *
 * `assistantId` and feature flags are read from top-level stores rather than
 * threaded through props, so the provider stays decoupled from any one domain.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";

import { toast } from "@vellum/design-library/components/toast";
import { client } from "@/generated/api/client.gen";
import { inferenceProviderconnectionsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { ProfileEditorModal } from "@/domains/settings/ai/profile-editor-modal";
import { filterFlaggedConnections } from "@/domains/settings/ai/provider-connections-client";
import type { ProfileEntry } from "@/domains/settings/ai/ai-types";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

interface OpenProfileQuickAddArgs {
  /**
   * Names already present, used only for the modal's immediate client-side
   * duplicate-name feedback. The authoritative dedupe + `profileOrder` append
   * happens at save time from a fresh server config fetch (see `handleSave`),
   * so this list is a UX nicety, not a correctness dependency.
   */
  existingNames?: string[];
  /**
   * Invoked with the new profile name after the create persists. The caller
   * runs its own follow-up (e.g. autoselecting the profile for the thread).
   */
  onCreated?: (newProfileName: string) => void;
}

interface ProfileQuickAddContextValue {
  openProfileQuickAdd: (args?: OpenProfileQuickAddArgs) => void;
}

const ProfileQuickAddContext = createContext<ProfileQuickAddContextValue | null>(
  null,
);

export function ProfileQuickAddProvider({ children }: { children: ReactNode }) {
  const assistantId = useAssistantSelectionStore.use.activeAssistantId();
  const openAICompatibleEndpoints =
    useAssistantFeatureFlagStore.use.openAICompatibleEndpoints();
  const chatgptSubscriptionAuth =
    useAssistantFeatureFlagStore.use.chatgptSubscriptionAuth();

  const [isOpen, setIsOpen] = useState(false);
  const [existingNames, setExistingNames] = useState<string[]>([]);
  // Held in a ref so the modal's onSave closure always sees the latest caller
  // callback without re-creating handlers on every open.
  const onCreatedRef = useRef<((newProfileName: string) => void) | undefined>(
    undefined,
  );

  const openProfileQuickAdd = useCallback((args?: OpenProfileQuickAddArgs) => {
    setExistingNames(args?.existingNames ?? []);
    onCreatedRef.current = args?.onCreated;
    setIsOpen(true);
  }, []);

  // Provider connections feed the modal's Provider picker. Gated on `isOpen`
  // (and a known assistant) so the query doesn't fire until the user actually
  // starts creating a profile.
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: isOpen && !!assistantId,
  });
  const connections = useMemo(
    () =>
      connectionsData
        ? filterFlaggedConnections(
            connectionsData.connections,
            openAICompatibleEndpoints,
          )
        : undefined,
    [connectionsData, openAICompatibleEndpoints],
  );

  // Persist a freshly-created profile, then hand the name back to the caller.
  // Mirrors ManageProfilesModal's create path: write `llm.profiles[name]` plus
  // an appended `profileOrder` in a single config PATCH so the daemon records
  // both the entry and its picker position.
  //
  // The order is computed from a FRESH server fetch rather than the
  // `profileOrder` captured when the modal opened. The caller may have opened
  // the quick-add before its own config fetch settled (passing an empty
  // order); trusting that would reset the persisted `profileOrder` to just the
  // new name, dropping every existing profile's position. Reading the latest
  // config here keeps the append authoritative regardless of stale inputs.
  const handleSave = useCallback(
    async (name: string, entry: ProfileEntry) => {
      if (!assistantId) return;

      // throwOnError: true so a failed reload ABORTS the save. With a swallowed
      // error the empty fallbacks below would treat the server config as empty
      // and the PATCH would reset `profileOrder` (and could overwrite an
      // existing key) on a merely transient read failure. Letting it throw
      // propagates to the modal's save handler, which surfaces the error inline
      // and keeps the modal open — no PATCH, no success toast.
      const configResult = await client.get<Record<string, unknown>, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      const llm =
        (configResult.data as { llm?: Record<string, unknown> } | undefined)
          ?.llm ?? {};
      const serverOrder = (llm.profileOrder as string[] | undefined) ?? [];
      const serverProfiles =
        (llm.profiles as Record<string, unknown> | undefined) ?? {};
      // Dedupe against the union of order + map entries (an entry can exist in
      // the map without being in the order), then append only if absent.
      const existsOnServer =
        serverOrder.includes(name) || name in serverProfiles;
      const profileOrderPatch = existsOnServer
        ? undefined
        : [...serverOrder, name];

      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: {
          llm: {
            profiles: { [name]: entry },
            ...(profileOrderPatch ? { profileOrder: profileOrderPatch } : {}),
          },
        },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
      onCreatedRef.current?.(name);
      setIsOpen(false);
      toast.success(`Profile "${name}" created`);
    },
    [assistantId],
  );

  const value = useMemo<ProfileQuickAddContextValue>(
    () => ({ openProfileQuickAdd }),
    [openProfileQuickAdd],
  );

  return (
    <ProfileQuickAddContext.Provider value={value}>
      {children}
      {assistantId ? (
        <ProfileEditorModal
          isOpen={isOpen}
          mode="create"
          existingNames={existingNames}
          connections={connections}
          openAICompatibleEndpointsEnabled={openAICompatibleEndpoints}
          assistantId={assistantId}
          chatgptSubscriptionEnabled={chatgptSubscriptionAuth}
          onSave={handleSave}
          onCancel={() => setIsOpen(false)}
        />
      ) : null}
    </ProfileQuickAddContext.Provider>
  );
}

/**
 * Imperative opener for the profile quick-add modal. Throws if used outside
 * `ProfileQuickAddProvider` so a missing provider fails loudly rather than
 * silently no-op'ing.
 */
export function useProfileQuickAdd(): ProfileQuickAddContextValue {
  const ctx = useContext(ProfileQuickAddContext);
  if (!ctx) {
    throw new Error(
      "useProfileQuickAdd() called outside <ProfileQuickAddProvider>. " +
        "Mount the consumer under the provider (composed in AppProviders).",
    );
  }
  return ctx;
}
