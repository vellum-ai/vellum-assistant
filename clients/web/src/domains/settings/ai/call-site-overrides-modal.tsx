import { Loader2, Search } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  profilePickerLabel,
  selectSeedProfileForOverride,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { getDefaultModelForProvider } from "@/assistant/llm-model-catalog";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import {
  CUSTOM_SENTINEL,
  draftsEqual,
  isDraftActive,
} from "@/domains/settings/ai/call-site-helpers";
import { CallSiteOverrideRow } from "@/domains/settings/ai/call-site-overrides-row";
import { INFERENCE_PROVIDERS } from "@/domains/settings/ai/constants";
import { useSelectableInferenceProviders } from "@/domains/settings/ai/provider-availability";
import { buildOrderedProfiles } from "@/domains/settings/ai/utils";
import {
  configGetOptions,
  configGetSetQueryData,
  configLlmCallsitesGetOptions,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  CallSiteOverrideDraft,
  ConfigLlmCallsitesGetResponse,
} from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CallSiteCatalog = ConfigLlmCallsitesGetResponse;
type CallSiteEntry = CallSiteCatalog["callSites"][number];
type CallSiteDomain = CallSiteCatalog["domains"][number];

export interface CallSiteOverridesModalProps {
  isOpen: boolean;
  onClose: () => void;
  assistantId: string;
}

// ---------------------------------------------------------------------------
// CallSiteOverridesModal
// ---------------------------------------------------------------------------

export function CallSiteOverridesModal({
  isOpen,
  onClose,
  assistantId,
}: CallSiteOverridesModalProps) {
  const savingRef = useRef(false);
  return (
    <Modal.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (!next && !savingRef.current) onClose();
      }}
    >
      {isOpen ? (
        <CallSiteOverridesModalInner
          assistantId={assistantId}
          onClose={onClose}
          onSavingChange={(s) => {
            savingRef.current = s;
          }}
        />
      ) : null}
    </Modal.Root>
  );
}

// ---------------------------------------------------------------------------
// Inner component (only mounted when open to reset state on close)
// ---------------------------------------------------------------------------

interface InnerProps {
  assistantId: string;
  onClose: () => void;
  onSavingChange?: (isSaving: boolean) => void;
}

function CallSiteOverridesModalInner({
  assistantId,
  onClose,
  onSavingChange,
}: InnerProps) {
  const queryClient = useQueryClient();

  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  const profiles = useMemo(
    () => daemonConfig?.llm?.profiles ?? {},
    [daemonConfig?.llm?.profiles],
  );
  const profileOrder = useMemo(
    () => daemonConfig?.llm?.profileOrder ?? [],
    [daemonConfig?.llm?.profileOrder],
  );
  const persistedOverrides = useMemo(
    () => daemonConfig?.llm?.callSites ?? {},
    [daemonConfig?.llm?.callSites],
  );
  const orderedProfiles = useMemo(
    () => buildOrderedProfiles(profiles, profileOrder),
    [profiles, profileOrder],
  );
  const selectableInferenceProviders = useSelectableInferenceProviders();

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
    },
  });

  const [search, setSearch] = useState("");
  const [draftEdits, setDraftEdits] = useState<
    Record<string, CallSiteOverrideDraft | null>
  >({});
  const [saving, setSaving] = useState(false);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);
  const analyzeConversationEnabled =
    useAssistantFeatureFlagStore.use.analyzeConversation();

  const {
    data: catalog,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    ...configLlmCallsitesGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: !!assistantId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const gatedCallSites = useMemo(() => {
    let all = (catalog?.callSites ?? []).filter((cs) => cs.id !== "mainAgent");
    if (!analyzeConversationEnabled) {
      all = all.filter((cs) => cs.id !== "analyzeConversation");
    }
    return all;
  }, [catalog, analyzeConversationEnabled]);

  const catalogLoaded = !isLoading && !isError && !!catalog;
  const daemonConfigLoaded = !!daemonConfig;
  const isSeeded = catalogLoaded && daemonConfigLoaded;

  const catalogCallSiteIds = useMemo(
    () => gatedCallSites.map((c) => c.id),
    [gatedCallSites],
  );

  // Derive the full draft map: persisted server values merged with any
  // user edits made this session. When the user hasn't touched a row,
  // it falls through to the persisted override (or empty).
  const drafts = useMemo((): Record<string, CallSiteOverrideDraft | null> => {
    if (!isSeeded) return {};
    const merged: Record<string, CallSiteOverrideDraft | null> = {};
    for (const id of catalogCallSiteIds) {
      if (id in draftEdits) {
        merged[id] = draftEdits[id];
      } else {
        const persisted = persistedOverrides[id];
        merged[id] = persisted ? { ...persisted } : {};
      }
    }
    return merged;
  }, [isSeeded, catalogCallSiteIds, persistedOverrides, draftEdits]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const gatedCallSiteIdSet = useMemo(
    () => new Set(catalogCallSiteIds),
    [catalogCallSiteIds],
  );

  const hasAnyPersistedOverride = useMemo(
    () =>
      Object.entries(persistedOverrides).some(
        ([id, s]) =>
          gatedCallSiteIdSet.has(id) &&
          (s?.profile != null || s?.provider != null || s?.model != null),
      ),
    [persistedOverrides, gatedCallSiteIdSet],
  );

  const hasUnsavedDrafts = useMemo(() => {
    if (!isSeeded) return false;
    for (const id of Object.keys(drafts)) {
      if (!draftsEqual(drafts[id], persistedOverrides[id])) return true;
    }
    return false;
  }, [isSeeded, drafts, persistedOverrides]);

  const hasValidationError = useMemo(
    () =>
      Object.values(drafts).some(
        (d) => isDraftActive(d) && !!d?.provider && !d?.model,
      ),
    [drafts],
  );

  const buildProfileOptionsForRow = useCallback(
    (selectedProfile: string | null) => {
      const visible = visibleProfilesForPicker(orderedProfiles, [
        selectedProfile,
      ]);
      return [
        ...visible.map((p) => ({
          value: p.name,
          label: profilePickerLabel(p),
        })),
        { value: CUSTOM_SENTINEL, label: "Custom" },
      ];
    },
    [orderedProfiles],
  );

  const filteredCallSites = useMemo(() => {
    if (!search.trim()) return gatedCallSites;
    const q = search.toLowerCase();
    return gatedCallSites.filter(
      (cs) =>
        (cs.displayName ?? "").toLowerCase().includes(q) ||
        (cs.description ?? "").toLowerCase().includes(q) ||
        (cs.domain ?? "").toLowerCase().includes(q),
    );
  }, [gatedCallSites, search]);

  const groupedCallSites = useMemo(() => {
    if (!catalog) return [];
    const domainOrder = catalog.domains.map((d) => d.id);
    const domainMap = new Map(catalog.domains.map((d) => [d.id, d]));
    const groups: { domain: CallSiteDomain; sites: CallSiteEntry[] }[] = [];
    for (const domainId of domainOrder) {
      const sites = filteredCallSites.filter((cs) => cs.domain === domainId);
      if (sites.length > 0) {
        groups.push({ domain: domainMap.get(domainId)!, sites });
      }
    }
    const knownDomains = new Set(domainOrder);
    const unknownSites = filteredCallSites.filter(
      (cs) => !knownDomains.has(cs.domain),
    );
    if (unknownSites.length > 0) {
      groups.push({
        domain: { id: "other", displayName: "Other" },
        sites: unknownSites,
      });
    }
    return groups;
  }, [catalog, filteredCallSites]);

  // ---------------------------------------------------------------------------
  // Row callbacks
  // ---------------------------------------------------------------------------

  const handleDraftChange = useCallback(
    (id: string, draft: CallSiteOverrideDraft | null) => {
      setDraftEdits((prev) => ({ ...prev, [id]: draft }));
    },
    [],
  );

  const handleToggle = useCallback(
    (id: string, on: boolean) => {
      if (!on) {
        setDraftEdits((prev) => ({ ...prev, [id]: null }));
        return;
      }
      const cs = gatedCallSites.find((c) => c.id === id);
      const seedProfile = selectSeedProfileForOverride(
        orderedProfiles,
        cs?.defaultProfile,
      );
      if (seedProfile) {
        setDraftEdits((prev) => ({ ...prev, [id]: { profile: seedProfile } }));
      } else {
        const defaultProvider =
          selectableInferenceProviders[0] ?? INFERENCE_PROVIDERS[0];
        const defaultModel = getDefaultModelForProvider(defaultProvider) ?? "";
        setDraftEdits((prev) => ({
          ...prev,
          [id]: { provider: defaultProvider, model: defaultModel },
        }));
      }
    },
    [gatedCallSites, orderedProfiles, selectableInferenceProviders],
  );

  // ---------------------------------------------------------------------------
  // Save / Reset
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    setSaving(true);
    onSavingChange?.(true);
    try {
      const patch: Record<string, CallSiteOverrideDraft | null> = {};
      for (const id of Object.keys(drafts)) {
        const d = drafts[id] ?? null;
        patch[id] = isDraftActive(d)
          ? {
              profile: d?.profile ?? null,
              provider: d?.provider ?? null,
              model: d?.model ?? null,
            }
          : null;
      }
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: { callSites: patch } },
      });
      onClose();
      toast.success("Overrides saved.");
    } catch (error) {
      toast.error("Failed to save overrides. Please try again.");
      captureError(error, { context: "call_site_overrides_save" });
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  }, [drafts, onClose, configMutation, onSavingChange, assistantId]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    onSavingChange?.(true);
    try {
      const resetPatch: Record<string, null> = {};
      for (const id of Object.keys(drafts)) {
        resetPatch[id] = null;
      }
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: { callSites: resetPatch } },
      });
      onClose();
      toast.success("Overrides reset.");
    } catch (error) {
      toast.error("Failed to reset overrides. Please try again.");
      captureError(error, { context: "call_site_overrides_reset" });
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  }, [drafts, onClose, configMutation, onSavingChange, assistantId]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Modal.Content size="lg" hideCloseButton>
      <Modal.Header>
        <Modal.Title>Action Overrides</Modal.Title>
        <Modal.Description>
          Customize which model profile specific actions should use. Uses your
          default profile if no override is set.
        </Modal.Description>
      </Modal.Header>

      <Modal.Body>
        {/* Search */}
        <div className="mb-4">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search actions…"
            leftIcon={<Search className="h-4 w-4" />}
            fullWidth
          />
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
          </div>
        )}

        {/* Error */}
        {isError && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-body-medium-default text-[var(--content-default)]">
              Couldn&apos;t load actions
            </p>
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              Make sure your assistant is running
            </p>
            <Button
              variant="outlined"
              size="compact"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </div>
        )}

        {/* Call site list grouped by domain */}
        {!isLoading && !isError && catalog && (
          <div className="space-y-4">
            {groupedCallSites.length === 0 ? (
              <p className="py-8 text-center text-body-medium-lighter text-[var(--content-tertiary)]">
                No actions match your search.
              </p>
            ) : (
              groupedCallSites.map(({ domain, sites }) => (
                <div key={domain.id}>
                  {/* typography: off-scale — domain section label uses semibold+tracking for visual grouping */}
                  <p className="mb-2 text-body-small-default font-semibold uppercase tracking-wider text-[var(--content-tertiary)]">
                    {domain.displayName}
                  </p>
                  <div className="space-y-1">
                    {sites.map((cs) => {
                      const profileVal = (() => {
                        const d = drafts[cs.id] ?? null;
                        if (!d || !isDraftActive(d)) return "";
                        if (d.provider || d.model) return CUSTOM_SENTINEL;
                        return d.profile ?? "";
                      })();
                      const defaultProfileLabel = cs.defaultProfile
                        ? (orderedProfiles.find(
                            (op) => op.name === cs.defaultProfile,
                          )?.label ?? cs.defaultProfile)
                        : null;

                      return (
                        <CallSiteOverrideRow
                          key={cs.id}
                          id={cs.id}
                          displayName={cs.displayName}
                          description={cs.description}
                          defaultProfileLabel={defaultProfileLabel}
                          draft={drafts[cs.id] ?? null}
                          profileOptions={buildProfileOptionsForRow(
                            profileVal === "" || profileVal === CUSTOM_SENTINEL
                              ? null
                              : profileVal,
                          )}
                          onDraftChange={handleDraftChange}
                          onToggle={handleToggle}
                        />
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </Modal.Body>

      <Modal.Footer>
        {hasAnyPersistedOverride && (
          <Button
            variant="outlined"
            size="compact"
            onClick={() => setShowResetConfirmation(true)}
            disabled={saving || !isSeeded}
            tintColor="var(--system-negative-strong)"
            className="mr-auto"
          >
            Reset to Defaults
          </Button>
        )}
        <Button
          variant="outlined"
          size="compact"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="compact"
          onClick={() => void handleSave()}
          disabled={!hasUnsavedDrafts || hasValidationError || saving}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </Button>
      </Modal.Footer>

      <ConfirmDialog
        open={showResetConfirmation}
        title="Reset to Defaults"
        message="Every task override will be reset and will follow your active profile. This cannot be undone."
        confirmLabel="Reset to Defaults"
        destructive
        onConfirm={() => {
          setShowResetConfirmation(false);
          void handleReset();
        }}
        onCancel={() => setShowResetConfirmation(false)}
      />
    </Modal.Content>
  );
}
