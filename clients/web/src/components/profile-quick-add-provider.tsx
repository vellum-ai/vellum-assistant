/**
 * App-level controller for the profile quick-add ("New Model") flow.
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
 * the feature-flag props, the create-persistence config PATCH, and the
 * success toast.
 *
 * Persistence goes through the settings-owned `useLlmConfigPatch` mutation
 * (allowed here — `local/no-cross-domain-imports` only restricts imports
 * between peer domains, not from top-level dirs like this one), so the cache
 * write and catalog invalidations match the settings save path. What differs
 * from that path is create-flow hardening the modal's caller can't provide:
 * `profileOrder` is sourced from a fresh authoritative server fetch (not a
 * captured prop), and a server-side duplicate-existence guard rejects a name
 * that already exists. See `handleSave`.
 *
 * `assistantId` and feature flags are read from top-level stores rather than
 * threaded through props, so the provider stays decoupled from any one domain.
 */
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { ProfilePatchEntryWritable } from "@/generated/daemon/types.gen";
import { ProfileEditorModal } from "@/domains/settings/ai/profile-editor-modal";
import { probeSavedProfile } from "@/domains/settings/ai/use-profile-save";
import { useLlmConfigPatch } from "@/domains/settings/ai/use-llm-config-patch";
import { configGet } from "@/generated/daemon/sdk.gen";
import { inferenceProviderconnectionsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { toast } from "@vellumai/design-library/components/toast";

interface OpenProfileQuickAddArgs {
  /**
   * Names already present, used only for the modal's immediate client-side
   * duplicate-name feedback. The authoritative dedupe + `profileOrder` append
   * happens at save time from a fresh server config fetch (see `handleSave`),
   * so this list is a UX nicety, not a correctness dependency.
   */
  existingNames?: string[];
  /**
   * Invoked with the new profile's key and its display-name label after the
   * create persists. The caller runs its own follow-up (e.g. autoselecting the
   * profile for the thread) and uses `label` to render the picker entry with
   * its Name immediately, instead of falling back to the key until the next
   * config refetch. `label` is null when the user left the Name field empty.
   */
  onCreated?: (newProfileName: string, label: string | null) => void;
  /**
   * Invoked once the flow this call opened is over, whether it saved or was
   * cancelled, and also if a later `openProfileQuickAdd` takes the modal over.
   * A caller that suppressed its own UI for the duration (the composer holds
   * its floating pills row up while the modal has focus) uses it to stop.
   */
  onClosed?: () => void;
}

interface ProfileQuickAddContextValue {
  openProfileQuickAdd: (args?: OpenProfileQuickAddArgs) => void;
}

const ProfileQuickAddContext =
  createContext<ProfileQuickAddContextValue | null>(null);

export function ProfileQuickAddProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  const configMutation = useLlmConfigPatch();
  const [isOpen, setIsOpen] = useState(false);
  const [existingNames, setExistingNames] = useState<string[]>([]);
  // Held in a ref so the modal's onSave closure always sees the latest caller
  // callback without re-creating handlers on every open.
  const pendingRef = useRef<OpenProfileQuickAddArgs | undefined>(undefined);

  // Every exit from the flow runs through here, so a caller that is waiting on
  // `onClosed` hears exactly one close per open, and a second `open` call
  // releases the first caller instead of stranding it.
  const closePending = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = undefined;
    pending?.onClosed?.();
  }, []);

  const openProfileQuickAdd = useCallback(
    (args?: OpenProfileQuickAddArgs) => {
      closePending();
      setExistingNames(args?.existingNames ?? []);
      pendingRef.current = args;
      setIsOpen(true);
    },
    [closePending],
  );

  // Provider connections feed the modal's Provider picker. Gated on `isOpen`
  // (and a known assistant) so the query doesn't fire until the user actually
  // starts creating a profile.
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: isOpen && !!assistantId,
  });
  const connections = connectionsData?.connections;

  // Persist a freshly-created profile, then hand the name back to the caller.
  // Writes `llm.profiles[name]` plus an appended `profileOrder` in a single
  // config PATCH so the daemon records both the entry and its picker position.
  // The PATCH goes through `useLlmConfigPatch`, whose onSuccess writes the
  // merged config to the shared cache and invalidates the profile/call-site
  // catalogs — same convergence as every settings-surface write.
  //
  // The order is computed from a FRESH server fetch rather than the
  // `profileOrder` captured when the modal opened. The caller may have opened
  // the quick-add before its own config fetch settled (passing an empty
  // order); trusting that would reset the persisted `profileOrder` to just the
  // new name, dropping every existing profile's position. Reading the latest
  // config here keeps the append authoritative regardless of stale inputs.
  const handleSave = useCallback(
    async (name: string, entry: ProfilePatchEntryWritable) => {
      if (!assistantId) {
        return;
      }

      // throwOnError: true so a failed reload ABORTS the save. With a swallowed
      // error the empty fallbacks below would treat the server config as empty
      // and the PATCH would reset `profileOrder` (and could overwrite an
      // existing key) on a merely transient read failure. Letting it throw
      // propagates to the modal's save handler, which surfaces the error inline
      // and keeps the modal open — no PATCH, no success toast.
      const configResult = await configGet({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      const llm = configResult.data?.llm;
      const serverOrder = llm?.profileOrder ?? [];
      const serverProfiles = llm?.profiles ?? {};
      // Abort if the name already exists on the server (union of order + map —
      // an entry can exist in the map without being in the order). This is a
      // create flow, and config PATCHes deep-merge profile entries, so writing
      // `profiles[name]` for an existing key would silently overwrite that
      // profile's provider/model rather than reporting the duplicate. Throwing
      // surfaces the error in the modal and leaves the existing profile intact.
      // (The modal also dedupes client-side; this guards races and stale state.)
      const existsOnServer =
        serverOrder.includes(name) || name in serverProfiles;
      if (existsOnServer) {
        throw new Error(`A profile with the key "${name}" already exists.`);
      }

      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: {
          llm: {
            profiles: { [name]: entry },
            profileOrder: [...serverOrder, name],
          },
        },
      });
      // Hand back the display-name label alongside the key so the caller's
      // optimistic picker entry renders the Name immediately rather than
      // showing the key until the next config refetch. The create form derives
      // the key from the Name, but they differ (slugified, possibly deduped),
      // so the picker must be given the label explicitly.
      const label = (entry.label ?? "").trim() || null;
      pendingRef.current?.onCreated?.(name, label);
      closePending();
      setIsOpen(false);
      toast.success(
        t("profileQuickAddProvider.created", { name: label ?? name }),
      );
      void probeSavedProfile(assistantId, name);
    },
    [assistantId, configMutation, closePending, t],
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
          assistantId={assistantId}
          onSave={handleSave}
          onCancel={() => {
            closePending();
            setIsOpen(false);
          }}
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
