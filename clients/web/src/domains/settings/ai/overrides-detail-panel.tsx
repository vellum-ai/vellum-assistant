import { AlertCircle, Loader2, Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  profilePickerIssue,
  profilePickerLabel,
  selectSeedProfileForOverride,
  undispatchableProfileReason,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { getDefaultModelForProvider } from "@/assistant/llm-model-catalog";
import { AdvisorProfileRow } from "@/domains/settings/ai/advisor-profile-row";
import { BulkOverrideSwapModal } from "@/domains/settings/ai/bulk-override-swap-modal";
import {
  CUSTOM_SENTINEL,
  effectiveCallSiteProfile,
} from "@/domains/settings/ai/call-site-helpers";
import { INFERENCE_PROVIDERS } from "@/domains/settings/ai/constants";
import {
  type CallSiteGroup,
  OverridesCallSiteList,
} from "@/domains/settings/ai/overrides-call-site-list";
import { useSelectableInferenceProviders } from "@/domains/settings/ai/provider-availability";
import { useOverrideDrafts } from "@/domains/settings/ai/use-override-drafts";
import {
  buildOrderedProfiles,
  profileDisplayLabel,
} from "@/domains/settings/ai/utils";
import {
  configGetOptions,
  configLlmCallsitesGetOptions,
  inferenceProviderconnectionsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useLlmConfigPatch } from "@/domains/settings/ai/use-llm-config-patch";
import { useSupportsCompleteProfileSnapshots } from "@/lib/backwards-compat/complete-profile-snapshots";
import { captureError } from "@/lib/sentry/capture-error";
import { DetailShell } from "@/components/detail-shell";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

export interface OverridesDetailPanelProps {
  assistantId: string;
  onClose: () => void;
}

/**
 * Sidepanel host for the Action Overrides editor (the Overrides section's
 * Manage action): search, the Advisor row, and per-call-site rows grouped
 * by domain in the scrollable body, with Save / Reset pinned in the
 * DetailShell footer so a long catalog never hides the actions. Hosts
 * remount the panel per open so draft state resets.
 */
export function OverridesDetailPanel({
  assistantId,
  onClose,
}: OverridesDetailPanelProps) {
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
  // Older assistants live-inherit blank profile fields at resolution time,
  // so a sparse profile dispatches there and must not be judged incomplete.
  const requireOwnProviderAndModel = useSupportsCompleteProfileSnapshots();
  const dispatchOptions = useMemo(
    () => ({ requireOwnProviderAndModel }),
    [requireOwnProviderAndModel],
  );

  const configMutation = useLlmConfigPatch(assistantId);

  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);
  const [showBulkSwap, setShowBulkSwap] = useState(false);

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

  // Custom-override rows limit their model picker to what the provider's
  // connections can dispatch; shared TanStack cache with the sections and
  // sidepanels.
  const { data: connectionsData } = useQuery({
    ...inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: !!assistantId,
  });

  const gatedCallSites = useMemo(
    () => (catalog?.callSites ?? []).filter((cs) => cs.id !== "mainAgent"),
    [catalog],
  );

  const catalogLoaded = !isLoading && !isError && !!catalog;
  const daemonConfigLoaded = !!daemonConfig;
  const isSeeded = catalogLoaded && daemonConfigLoaded;

  const catalogCallSiteIds = useMemo(
    () => gatedCallSites.map((c) => c.id),
    [gatedCallSites],
  );

  // The advisor is a top-level `llm.advisorProfile` selection, not a call-site
  // override. It rides this panel's draft/Save cycle but never enters the
  // `llm.callSites` patch or the Overrides count.
  const persistedAdvisor = daemonConfig?.llm?.advisorProfile ?? "";

  const {
    drafts,
    advisorProfile,
    advisorDirty,
    callSiteDraftsDirty,
    hasUnsavedDrafts,
    hasValidationError,
    setDraft,
    setAdvisor,
    clearEdits,
    buildSavePatch,
    buildResetPatch,
  } = useOverrideDrafts({
    catalogCallSiteIds,
    persistedOverrides,
    persistedAdvisor,
    isSeeded,
  });

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const gatedCallSiteIdSet = useMemo(
    () => new Set(catalogCallSiteIds),
    [catalogCallSiteIds],
  );

  const profileLabelFor = useCallback(
    (name: string) => profileDisplayLabel(orderedProfiles, name),
    [orderedProfiles],
  );

  // An entry only reaches a picker while undispatchable when it is the
  // current selection. It carries the same warning affordance the Profiles
  // row uses, rather than a word appended to its name.
  const toProfileOption = useCallback(
    (p: (typeof orderedProfiles)[number]) => ({
      value: p.name,
      label: profilePickerLabel(p),
      ...(profilePickerIssue(p, orderedProfiles, dispatchOptions) ===
      "undispatchable"
        ? {
            icon: (
              <AlertCircle className="h-3.5 w-3.5 text-[var(--system-mid-strong)]" />
            ),
            tooltip: undispatchableProfileReason(p),
          }
        : {}),
    }),
    [orderedProfiles, dispatchOptions],
  );

  const advisorOptions = useMemo(
    () =>
      visibleProfilesForPicker(
        orderedProfiles,
        [persistedAdvisor],
        dispatchOptions,
      ).map(toProfileOption),
    [orderedProfiles, persistedAdvisor, toProfileOption, dispatchOptions],
  );

  // "advisor" isn't in the call-site catalog, so its row filters on its own
  // copy rather than falling out of `filteredCallSites`.
  const advisorMatchesSearch = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q === "" || "advisor".includes(q) || "second opinion".includes(q);
  }, [search]);

  // The bulk swap needs at least one action currently running on a named
  // profile, via an override or its default. Provider/model ("Custom") pins
  // and sites with no resolvable default are out of its reach.
  const hasBulkSwapCandidates = useMemo(
    () =>
      gatedCallSites.some(
        (cs) =>
          effectiveCallSiteProfile(cs, persistedOverrides[cs.id]) !== null,
      ),
    [gatedCallSites, persistedOverrides],
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

  const buildProfileOptionsForRow = useCallback(
    (selectedProfile: string | null) => {
      const visible = visibleProfilesForPicker(
        orderedProfiles,
        [selectedProfile],
        dispatchOptions,
      );
      return [
        ...visible.map(toProfileOption),
        { value: CUSTOM_SENTINEL, label: "Custom" },
      ];
    },
    [orderedProfiles, toProfileOption, dispatchOptions],
  );

  const filteredCallSites = useMemo(() => {
    if (!search.trim()) {
      return gatedCallSites;
    }
    const q = search.toLowerCase();
    return gatedCallSites.filter(
      (cs) =>
        (cs.displayName ?? "").toLowerCase().includes(q) ||
        (cs.description ?? "").toLowerCase().includes(q) ||
        (cs.domain ?? "").toLowerCase().includes(q),
    );
  }, [gatedCallSites, search]);

  const groupedCallSites = useMemo(() => {
    if (!catalog) {
      return [];
    }
    const domainOrder = catalog.domains.map((d) => d.id);
    const domainMap = new Map(catalog.domains.map((d) => [d.id, d]));
    const groups: CallSiteGroup[] = [];
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

  const handleToggle = useCallback(
    (id: string, on: boolean) => {
      if (!on) {
        setDraft(id, null);
        return;
      }
      const cs = gatedCallSites.find((c) => c.id === id);
      const seedProfile = selectSeedProfileForOverride(
        orderedProfiles,
        cs?.defaultProfile,
        dispatchOptions,
      );
      if (seedProfile) {
        setDraft(id, { profile: seedProfile });
      } else {
        const defaultProvider =
          selectableInferenceProviders[0] ?? INFERENCE_PROVIDERS[0];
        const defaultModel = getDefaultModelForProvider(defaultProvider) ?? "";
        setDraft(id, { provider: defaultProvider, model: defaultModel });
      }
    },
    [
      gatedCallSites,
      orderedProfiles,
      selectableInferenceProviders,
      setDraft,
      dispatchOptions,
    ],
  );

  // ---------------------------------------------------------------------------
  // Save / Reset
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const patch = buildSavePatch();
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: {
          llm: {
            // Each key is rewritten from the picker's three fields, which
            // drops any tuning field (effort, thinking, maxTokens) a
            // persisted entry carries. Send the map only when a call-site
            // row actually moved, so an Advisor-only Save cannot reach it.
            ...(callSiteDraftsDirty ? { callSites: patch } : {}),
            // Likewise: a no-op key would still rewrite the config file.
            ...(advisorDirty ? { advisorProfile } : {}),
          },
        },
      });
      onClose();
      toast.success("Overrides saved.");
    } catch (error) {
      toast.error("Failed to save overrides. Please try again.");
      captureError(error, { context: "call_site_overrides_save" });
    } finally {
      setSaving(false);
    }
  }, [
    buildSavePatch,
    callSiteDraftsDirty,
    advisorDirty,
    advisorProfile,
    onClose,
    configMutation,
    assistantId,
  ]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    try {
      const resetPatch = buildResetPatch();
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
    }
  }, [buildResetPatch, onClose, configMutation, assistantId]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const footer = (
    <div className="flex items-center justify-end gap-2">
      {hasAnyPersistedOverride && (
        <Button
          variant="outlined"
          onClick={() => setShowResetConfirmation(true)}
          disabled={saving || !isSeeded}
          tintColor="var(--system-negative-strong)"
          className="mr-auto"
        >
          Reset to Defaults
        </Button>
      )}
      <Button
        variant="primary"
        onClick={() => void handleSave()}
        disabled={!hasUnsavedDrafts || hasValidationError || saving}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
      </Button>
    </div>
  );

  return (
    <DetailShell
      title="Action Overrides"
      closeVariant="outlined"
      onClose={onClose}
      footer={footer}
    >
      <p className="mb-4 text-body-medium-lighter text-[var(--content-tertiary)]">
        Customize which model profile specific actions should use. Uses your
        default profile if no override is set.
      </p>

      <div>
        {/* Search + bulk change. The swap acts on persisted overrides, so it
            stays disabled while the editor holds unsaved drafts: applying it
            under a dirty draft would show stale rows and let a later Save
            silently undo the swap. */}
        <div className="mb-4 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search actions…"
              leftIcon={<Search className="h-4 w-4" />}
              fullWidth
            />
          </div>
          <Button
            variant="outlined"
            onClick={() => setShowBulkSwap(true)}
            disabled={
              !isSeeded || saving || hasUnsavedDrafts || !hasBulkSwapCandidates
            }
            title={
              hasUnsavedDrafts
                ? "Save or reset your changes first"
                : !hasBulkSwapCandidates
                  ? "No actions currently use a profile"
                  : undefined
            }
          >
            Bulk change
          </Button>
        </div>

        {/* Advisor: a top-level selection, not a catalog call site, so it
            renders off `daemonConfig` alone and stays put if the call-site
            catalog fails to load. */}
        {daemonConfigLoaded && advisorMatchesSearch && (
          <div className="mb-4">
            {/* typography: off-scale. Matches the domain section label below */}
            <p className="mb-2 text-body-small-default font-semibold uppercase tracking-wider text-[var(--content-tertiary)]">
              Advisor
            </p>
            <AdvisorProfileRow
              value={advisorProfile}
              profileOptions={advisorOptions}
              disabled={saving}
              onChange={setAdvisor}
            />
          </div>
        )}

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
            <Button variant="outlined" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        )}

        {/* Call site list grouped by domain */}
        {!isLoading && !isError && catalog && (
          <OverridesCallSiteList
            groups={groupedCallSites}
            drafts={drafts}
            buildProfileOptionsForRow={buildProfileOptionsForRow}
            profileLabelFor={profileLabelFor}
            advisorMatchesSearch={advisorMatchesSearch}
            connections={connectionsData?.connections}
            onDraftChange={setDraft}
            onToggle={handleToggle}
          />
        )}
      </div>

      {/* Mounted per open so source/target/selection state resets. Clears
          draft edits on apply: a stale touched-then-reverted edit would pin
          the pre-swap value over the freshly persisted one. */}
      {showBulkSwap && catalog && (
        <BulkOverrideSwapModal
          assistantId={assistantId}
          callSites={gatedCallSites}
          domains={catalog.domains}
          persistedOverrides={persistedOverrides}
          orderedProfiles={orderedProfiles}
          onClose={() => setShowBulkSwap(false)}
          onApplied={clearEdits}
        />
      )}

      <ConfirmDialog
        open={showResetConfirmation}
        title="Reset to Defaults"
        message="Every action override will be reset and will follow its default. This cannot be undone."
        confirmLabel="Reset to Defaults"
        destructive
        onConfirm={() => {
          setShowResetConfirmation(false);
          void handleReset();
        }}
        onCancel={() => setShowResetConfirmation(false)}
      />
    </DetailShell>
  );
}
