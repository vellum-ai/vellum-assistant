import { Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { Toggle } from "@vellum/design-library/components/toggle";
import { Modal } from "@vellum/design-library/components/modal";
import { toast } from "@vellum/design-library/components/toast";
import { client } from "@/generated/api/client.gen";
import { reportError } from "@/utils/error-report";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { getDefaultModelForProvider, getModelsForProvider } from "@/assistant/llm-model-catalog";

import { INFERENCE_PROVIDER_DISPLAY_NAMES, INFERENCE_PROVIDERS } from "@/domains/settings/ai/ai-page";
import {
  profilePickerLabel,
  visibleProfilesForPicker,
  type ProfilePickerEntry,
} from "@/domains/settings/ai/profile-pickers";

// ---------------------------------------------------------------------------
// Sentinel value for the "Custom" profile picker option
// ---------------------------------------------------------------------------

export const CUSTOM_SENTINEL = "__custom__";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CallSiteEntry {
  id: string;
  displayName: string;
  description: string;
  domain: string;
  defaultProfile?: string;
}

interface CallSiteDomain {
  id: string;
  displayName: string;
}

interface CallSiteCatalog {
  domains: CallSiteDomain[];
  callSites: CallSiteEntry[];
}

export interface CallSiteOverrideDraft {
  profile?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface CallSiteOverridesModalProps {
  isOpen: boolean;
  onClose: () => void;
  assistantId: string;
  /** The full ordered profile list, INCLUDING disabled entries. Each row's
   *  picker filters disabled profiles out unless that row currently selects
   *  one — needed so disabling the active profile doesn't strand an existing
   *  override with an empty trigger label. */
  orderedProfiles: ReadonlyArray<ProfilePickerEntry>;
  persistedOverrides: Record<string, CallSiteOverrideDraft | null | undefined>;
  /** Pass `!!daemonConfig` so the seeding effect waits for daemon config to load
   *  before locking in drafts. Without this guard, if the catalog resolves before
   *  daemonConfig, the modal seeds from an empty persistedOverrides and later
   *  ignores real overrides when they arrive, causing silent data loss on Save. */
  daemonConfigLoaded?: boolean;
  onSaved: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDraftActive(d: CallSiteOverrideDraft | null | undefined): boolean {
  if (!d) return false;
  return !!(d.profile || d.provider || d.model);
}

function draftsEqual(
  a: CallSiteOverrideDraft | null | undefined,
  b: CallSiteOverrideDraft | null | undefined,
): boolean {
  const aActive = isDraftActive(a);
  const bActive = isDraftActive(b);
  if (aActive !== bActive) return false;
  if (!aActive) return true;
  return (
    (a?.profile ?? null) === (b?.profile ?? null) &&
    (a?.provider ?? null) === (b?.provider ?? null) &&
    (a?.model ?? null) === (b?.model ?? null)
  );
}

// ---------------------------------------------------------------------------
// CallSiteOverridesModal
// ---------------------------------------------------------------------------

export function CallSiteOverridesModal({
  isOpen,
  onClose,
  assistantId,
  orderedProfiles,
  persistedOverrides,
  daemonConfigLoaded,
  onSaved,
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
          orderedProfiles={orderedProfiles}
          persistedOverrides={persistedOverrides}
          daemonConfigLoaded={daemonConfigLoaded}
          onClose={onClose}
          onSaved={onSaved}
          onSavingChange={(s) => { savingRef.current = s; }}
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
  orderedProfiles: ReadonlyArray<ProfilePickerEntry>;
  persistedOverrides: Record<string, CallSiteOverrideDraft | null | undefined>;
  daemonConfigLoaded?: boolean;
  onClose: () => void;
  onSaved: () => void;
  onSavingChange?: (isSaving: boolean) => void;
}

function CallSiteOverridesModalInner({
  assistantId,
  orderedProfiles,
  persistedOverrides,
  daemonConfigLoaded,
  onClose,
  onSaved,
  onSavingChange,
}: InnerProps) {
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, CallSiteOverrideDraft | null>>({});
  const [saving, setSaving] = useState(false);
  const [isSeeded, setIsSeeded] = useState(false);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);
  const seeded = useRef(false);
  const analyzeConversationEnabled = useAssistantFeatureFlagStore.use.analyzeConversation();

  const { data: catalog, isLoading, isError, refetch } = useQuery({
    queryKey: ["call-site-catalog", assistantId],
    queryFn: async () => {
      const { data } = await client.get<CallSiteCatalog, unknown, true>({
        url: `/v1/assistants/{assistant_id}/config/llm/call-sites`,
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      return data as CallSiteCatalog;
    },
    enabled: !!assistantId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // mainAgent is controlled by the main inference card / Default Profile, not this
  // modal. Filter it out here so we don't render a row whose edits we'd silently
  // drop in Save/Reset (LUM-1830).
  const gatedCallSites = useMemo(() => {
    const all = (catalog?.callSites ?? []).filter((cs) => cs.id !== "mainAgent");
    if (analyzeConversationEnabled) return all;
    return all.filter((cs) => cs.id !== "analyzeConversation");
  }, [catalog, analyzeConversationEnabled]);

  // Seed drafts once per open, but defer until BOTH the catalog and the daemon
  // config have loaded. Without the daemonConfigLoaded gate, the catalog can
  // resolve before daemonConfig, causing the effect to seal seeded.current=true
  // on an empty persistedOverrides — later real overrides are then ignored, and
  // clicking Save silently clears existing overrides (data loss).
  const catalogLoaded = !isLoading && !isError && !!catalog;
  const catalogCallSiteIds = useMemo(
    () => gatedCallSites.map((c) => c.id),
    [gatedCallSites],
  );

  // Inner is only ever mounted when the modal is open, so no !isOpen branch needed.
  // seeded.current resets to false automatically when the inner component unmounts.
  useEffect(() => {
    if (seeded.current) return;
    if (!catalogLoaded) return;
    // If the caller explicitly signals that daemon config has not loaded yet,
    // wait. When daemonConfigLoaded flips to true, persistedOverrides will
    // have updated too, re-triggering this effect with real data.
    // (undefined = caller didn't pass the flag; treat as loaded for compat.)
    if (daemonConfigLoaded === false) return;
    const initial: Record<string, CallSiteOverrideDraft | null> = {};
    for (const id of catalogCallSiteIds) {
      const persisted = persistedOverrides[id];
      initial[id] = persisted ? { ...persisted } : {};
    }
    setDrafts(initial);
    seeded.current = true;
    setIsSeeded(true);
  }, [catalogLoaded, daemonConfigLoaded, catalogCallSiteIds, persistedOverrides]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const availableProviders = INFERENCE_PROVIDERS;

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
    // Guard: drafts haven't been seeded yet (catalog still loading) — Save must stay disabled.
    // seeded.current is set synchronously before setDrafts, so this memo sees the correct
    // value on the re-render triggered by setDrafts.
    if (!seeded.current) return false;
    // Use catalog IDs only (keys of drafts) — orphaned stale overrides in
    // persistedOverrides that aren't in the catalog stay untouched.
    for (const id of Object.keys(drafts)) {
      if (!draftsEqual(drafts[id], persistedOverrides[id])) return true;
    }
    return false;
  }, [drafts, persistedOverrides]);

  const hasValidationError = useMemo(
    () =>
      Object.values(drafts).some(
        (d) => isDraftActive(d) && !!d?.provider && !d?.model,
      ),
    [drafts],
  );

  // Builds the profile picker options for a single row. The currently
  // selected profile (if any and currently disabled) stays in the option
  // list so the trigger can render a label — otherwise the dropdown would
  // show empty when an override targets a now-disabled profile. New
  // selections of *other* disabled profiles are still blocked by the
  // filter (they simply don't appear).
  const buildProfileOptionsForRow = useCallback(
    (selectedProfile: string | null) => {
      const visible = visibleProfilesForPicker(orderedProfiles, [selectedProfile]);
      return [
        ...visible.map((p) => ({ value: p.name, label: profilePickerLabel(p) })),
        { value: CUSTOM_SENTINEL, label: "Custom" },
      ];
    },
    [orderedProfiles],
  );

  // First active profile — used when toggling an override on without a draft,
  // so we never seed a freshly-toggled override with a disabled profile name.
  const firstActiveProfileName = useMemo(
    () => orderedProfiles.find((p) => p.status !== "disabled")?.name,
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
    const unknownSites = filteredCallSites.filter((cs) => !knownDomains.has(cs.domain));
    if (unknownSites.length > 0) {
      groups.push({ domain: { id: "other", displayName: "Other" }, sites: unknownSites });
    }
    return groups;
  }, [catalog, filteredCallSites]);

  // ---------------------------------------------------------------------------
  // Row helpers
  // ---------------------------------------------------------------------------

  function getDraft(id: string): CallSiteOverrideDraft | null {
    return drafts[id] ?? null;
  }

  function isOverrideOn(id: string): boolean {
    return isDraftActive(getDraft(id));
  }

  function getProfilePickerValue(id: string): string {
    const d = getDraft(id);
    if (!d || !isDraftActive(d)) return "";
    if (d.provider || d.model) return CUSTOM_SENTINEL;
    return d.profile ?? "";
  }

  function handleToggle(id: string, on: boolean, defaultProfile?: string) {
    if (!on) {
      setDrafts((prev) => ({ ...prev, [id]: null }));
      return;
    }
    const seedProfile =
      defaultProfile && orderedProfiles.some((p) => p.name === defaultProfile && p.status !== "disabled")
        ? defaultProfile
        : firstActiveProfileName;
    if (seedProfile) {
      setDrafts((prev) => ({ ...prev, [id]: { profile: seedProfile } }));
    } else {
      const defaultProvider = availableProviders[0];
      const defaultModel = getDefaultModelForProvider(defaultProvider) ?? "";
      setDrafts((prev) => ({
        ...prev,
        [id]: { provider: defaultProvider, model: defaultModel },
      }));
    }
  }

  function handleProfilePickerChange(id: string, val: string) {
    if (val === CUSTOM_SENTINEL) {
      const defaultProvider = availableProviders[0];
      const defaultModel = getDefaultModelForProvider(defaultProvider) ?? "";
      setDrafts((prev) => ({
        ...prev,
        [id]: { profile: null, provider: defaultProvider, model: defaultModel },
      }));
    } else if (val === "") {
      setDrafts((prev) => ({ ...prev, [id]: null }));
    } else {
      setDrafts((prev) => ({ ...prev, [id]: { profile: val, provider: null, model: null } }));
    }
  }

  function handleProviderChange(id: string, provider: string) {
    const defaultModel = getDefaultModelForProvider(provider) ?? "";
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...prev[id], profile: null, provider, model: defaultModel },
    }));
  }

  function handleModelChange(id: string, model: string) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], model } }));
  }

  // ---------------------------------------------------------------------------
  // Save / Reset
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    setSaving(true);
    onSavingChange?.(true);
    try {
      // Use catalog IDs only (keys of drafts) — orphaned stale overrides stay untouched.
      const patch: Record<string, CallSiteOverrideDraft | null> = {};
      for (const id of Object.keys(drafts)) {
        const d = drafts[id] ?? null;
        patch[id] = isDraftActive(d)
          ? { profile: d?.profile ?? null, provider: d?.provider ?? null, model: d?.model ?? null }
          : null;
      }
      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: { llm: { callSites: patch } },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
      onSaved();
      onClose();
      toast.success("Overrides saved.");
    } catch (error) {
      toast.error("Failed to save overrides. Please try again.");
      reportError(error, {
        context: "call_site_overrides_save",
        userMessage: "Failed to save overrides",
      });
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  }, [assistantId, drafts, onClose, onSaved, persistedOverrides]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    onSavingChange?.(true);
    try {
      // Use catalog IDs only (keys of drafts) — orphaned stale overrides stay untouched.
      const resetPatch: Record<string, null> = {};
      for (const id of Object.keys(drafts)) {
        resetPatch[id] = null;
      }
      await client.patch({
        url: `/v1/assistants/{assistant_id}/config`,
        path: { assistant_id: assistantId },
        body: { llm: { callSites: resetPatch } },
        headers: { "Content-Type": "application/json" },
        throwOnError: true,
      });
      onSaved();
      onClose();
      toast.success("Overrides reset.");
    } catch (error) {
      toast.error("Failed to reset overrides. Please try again.");
      reportError(error, {
        context: "call_site_overrides_reset",
        userMessage: "Failed to reset overrides",
      });
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  }, [assistantId, drafts, onClose, onSaved, persistedOverrides]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Modal.Content size="lg" hideCloseButton>
      <Modal.Header>
        <Modal.Title>Action Overrides</Modal.Title>
        <Modal.Description>
          Customize which model profile specific actions should use. Uses your default profile if no override is set.
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
            <Button variant="outlined" size="compact" onClick={() => void refetch()}>
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
                      const overrideOn = isOverrideOn(cs.id);
                      const profileVal = getProfilePickerValue(cs.id);
                      const isCustom = profileVal === CUSTOM_SENTINEL;
                      const draft = getDraft(cs.id);
                      const currentProvider = draft?.provider ?? availableProviders[0];
                      const availableModels = getModelsForProvider(currentProvider ?? "anthropic");
                      const modelOptions = availableModels.map((m) => ({
                        value: m.id,
                        label: m.displayName,
                      }));
                      const hasModelError = !!draft?.provider && !draft?.model;
                      // Row-specific profile options — keeps the row's
                      // currently-selected profile visible even if it's now
                      // disabled. profileVal is "" or CUSTOM_SENTINEL when
                      // no profile is in play, so we pass null in those
                      // cases (visibleProfilesForPicker ignores null).
                      const profileOptions = buildProfileOptionsForRow(
                        profileVal === "" || profileVal === CUSTOM_SENTINEL ? null : profileVal,
                      );

                      return (
                        <div
                          key={cs.id}
                          className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-3"
                        >
                          {/* Row: name + description on left, picker + toggle on right */}
                          <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              {/* typography: off-scale — call-site name uses medium weight for visual hierarchy within card */}
                              <p className="text-body-medium-default font-medium text-[var(--content-default)]">
                                {cs.displayName}
                              </p>
                              {cs.description && (
                                <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
                                  {cs.description}
                                  {cs.defaultProfile && (() => {
                                    const p = orderedProfiles.find((op) => op.name === cs.defaultProfile);
                                    const label = p?.label ?? cs.defaultProfile;
                                    return (
                                      <span className="ml-1.5 text-body-small-default text-[var(--content-tertiary)] opacity-60">
                                        &middot; Default: {label}
                                      </span>
                                    );
                                  })()}
                                </p>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {overrideOn && (
                                <Dropdown
                                  value={profileVal}
                                  onChange={(val) => handleProfilePickerChange(cs.id, val)}
                                  options={profileOptions}
                                  className="w-36"
                                />
                              )}
                              <Toggle
                                checked={overrideOn}
                                onChange={(on) => handleToggle(cs.id, on, cs.defaultProfile)}
                                aria-label={`Override ${cs.displayName}`}
                              />
                            </div>
                          </div>

                          {/* Custom provider + model pickers */}
                          {overrideOn && isCustom && (
                            <div className="mt-3 space-y-2 border-t border-[var(--border-base)] pt-3">
                              <div className="flex gap-2">
                                <div className="flex-1">
                                  <label className="mb-1 block text-body-small-default text-[var(--content-tertiary)]">
                                    Provider
                                  </label>
                                  <Dropdown
                                    value={currentProvider ?? ""}
                                    onChange={(val) => handleProviderChange(cs.id, val)}
                                    options={availableProviders.map((p) => ({
                                      value: p,
                                      label: INFERENCE_PROVIDER_DISPLAY_NAMES[p] ?? p,
                                    }))}
                                  />
                                </div>
                                <div className="flex-1">
                                  <label className="mb-1 block text-body-small-default text-[var(--content-tertiary)]">
                                    Model
                                  </label>
                                  <Dropdown
                                    value={draft?.model ?? ""}
                                    onChange={(val) => handleModelChange(cs.id, val)}
                                    options={modelOptions}
                                  />
                                </div>
                              </div>
                              {hasModelError && (
                                <p className="text-body-small-default text-[var(--system-negative-strong)]">
                                  Pick a model
                                </p>
                              )}
                            </div>
                          )}
                        </div>
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
        <Button variant="outlined" size="compact" onClick={onClose} disabled={saving}>
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
