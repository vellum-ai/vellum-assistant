import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Checkbox } from "@vellumai/design-library/components/checkbox";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";
import { toast } from "@vellumai/design-library/components/toast";

import {
  profilePickerLabel,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { isProfileOnlyOverride } from "@/domains/settings/ai/call-site-helpers";
import { useLlmConfigPatch } from "@/domains/settings/ai/use-llm-config-patch";
import {
  profileDisplayLabel,
  type ProfileWithName,
} from "@/domains/settings/ai/utils";
import type {
  CallSiteOverrideDraft,
  ConfigGetResponse,
  ConfigLlmCallsitesGetResponse,
} from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { badRequestMessage } from "@/utils/api-errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CallSiteEntry = ConfigLlmCallsitesGetResponse["callSites"][number];
type CallSiteDomain = ConfigLlmCallsitesGetResponse["domains"][number];
type PersistedOverrides = NonNullable<
  NonNullable<ConfigGetResponse["llm"]>["callSites"]
>;

export interface BulkOverrideSwapModalProps {
  assistantId: string;
  /** Catalog entries eligible for per-action overrides (no `mainAgent`). */
  callSites: ReadonlyArray<CallSiteEntry>;
  domains: ReadonlyArray<CallSiteDomain>;
  persistedOverrides: PersistedOverrides;
  orderedProfiles: ProfileWithName[];
  onClose: () => void;
  /** Fires after a successful apply, before the modal closes. */
  onApplied: () => void;
}

// ---------------------------------------------------------------------------
// BulkOverrideSwapModal
// ---------------------------------------------------------------------------

/**
 * One-time bulk swap over the persisted action overrides: every selected
 * override that uses the source profile is rewritten to the target profile
 * in a single `PATCH /v1/config`. Operates on persisted overrides only, so
 * hosts gate the entry point while the editor holds unsaved drafts. Mount
 * per open; selection state does not survive a close.
 */
export function BulkOverrideSwapModal({
  assistantId,
  callSites,
  domains,
  persistedOverrides,
  orderedProfiles,
  onClose,
  onApplied,
}: BulkOverrideSwapModalProps) {
  const configMutation = useLlmConfigPatch(assistantId);

  const referencedProfileNames = useMemo(() => {
    const referenced = new Set<string>();
    for (const cs of callSites) {
      const override = persistedOverrides[cs.id];
      if (isProfileOnlyOverride(override) && override?.profile) {
        referenced.add(override.profile);
      }
    }
    return referenced;
  }, [callSites, persistedOverrides]);

  // Profiles referenced by at least one override, in profile order. A
  // referenced name missing from the profile map cannot occur: the config
  // schema rejects overrides that point at nonexistent profiles.
  const sourceProfiles = useMemo(
    () => orderedProfiles.filter((p) => referencedProfileNames.has(p.name)),
    [orderedProfiles, referencedProfileNames],
  );

  const [source, setSource] = useState<string>(
    () => sourceProfiles[0]?.name ?? "",
  );
  const [target, setTarget] = useState<string>("");
  const [deselectedIds, setDeselectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [applying, setApplying] = useState(false);

  const domainLabelFor = useMemo(() => {
    const map = new Map(domains.map((d) => [d.id, d.displayName]));
    return (id: string) => map.get(id) ?? id;
  }, [domains]);

  const affected = useMemo(
    () =>
      callSites.filter((cs) => {
        const override = persistedOverrides[cs.id];
        return isProfileOnlyOverride(override) && override?.profile === source;
      }),
    [callSites, persistedOverrides, source],
  );

  const selectedIds = useMemo(
    () => affected.map((cs) => cs.id).filter((id) => !deselectedIds.has(id)),
    [affected, deselectedIds],
  );

  const sourceOptions = useMemo(
    () =>
      sourceProfiles.map((p) => ({
        value: p.name,
        label: profilePickerLabel(p),
      })),
    [sourceProfiles],
  );

  const targetOptions = useMemo(
    () =>
      visibleProfilesForPicker(orderedProfiles, [])
        .filter((p) => p.name !== source)
        .map((p) => ({ value: p.name, label: profilePickerLabel(p) })),
    [orderedProfiles, source],
  );

  const sourceLabel = profileDisplayLabel(orderedProfiles, source);
  const targetLabel = profileDisplayLabel(orderedProfiles, target);

  const overrideNoun = selectedIds.length === 1 ? "override" : "overrides";
  const allSelected = deselectedIds.size === 0;

  function handleSourceChange(next: string) {
    setSource(next);
    setDeselectedIds(new Set());
    if (next === target) {
      setTarget("");
    }
  }

  function toggleCallSite(id: string, checked: boolean) {
    setDeselectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleApply() {
    if (!source || !target || selectedIds.length === 0) {
      return;
    }
    setApplying(true);
    try {
      const callSitePatch: Record<string, CallSiteOverrideDraft> = {};
      for (const id of selectedIds) {
        callSitePatch[id] = { profile: target };
      }
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { llm: { callSites: callSitePatch } },
      });
      toast.success(
        `Updated ${selectedIds.length} ${overrideNoun} to "${targetLabel}".`,
      );
      onApplied();
      onClose();
    } catch (error) {
      // A 400 is the server's verdict on the selection itself (e.g. a
      // profile that no longer exists). Show it verbatim and skip Sentry.
      const serverMessage = badRequestMessage(error);
      toast.error(
        serverMessage ?? "Failed to update overrides. Please try again.",
      );
      if (!serverMessage) {
        captureError(error, { context: "settings-ai-bulk-override-swap" });
      }
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Modal.Content size="md">
        <Modal.Header>
          <Modal.Title>Change Action Overrides</Modal.Title>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          <Typography variant="body-medium-default" as="p">
            Update the actions that currently use one profile. The result is
            saved as individual overrides.
          </Typography>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label
                className="block text-body-small-default text-[var(--content-tertiary)]"
                id="bulk-swap-source-label"
              >
                Currently using
              </label>
              <Dropdown
                aria-labelledby="bulk-swap-source-label"
                value={source}
                onChange={handleSourceChange}
                options={sourceOptions}
              />
            </div>
            <div className="space-y-1">
              <label
                className="block text-body-small-default text-[var(--content-tertiary)]"
                id="bulk-swap-target-label"
              >
                Change to
              </label>
              <Dropdown
                aria-labelledby="bulk-swap-target-label"
                value={target}
                onChange={setTarget}
                placeholder="Select a profile…"
                options={targetOptions}
              />
            </div>
          </div>

          <Notice tone="info" title="This happens once.">
            It changes the selected overrides that use {sourceLabel} today. It
            does not create an ongoing rule between profiles.
          </Notice>

          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <div>
                <Typography variant="body-medium-default" as="p">
                  {affected.length}{" "}
                  {affected.length === 1 ? "override" : "overrides"} currently{" "}
                  {affected.length === 1 ? "uses" : "use"} {sourceLabel}
                </Typography>
                <Typography
                  variant="body-small-default"
                  as="p"
                  className="text-[color:var(--content-secondary)]"
                >
                  Choose which actions to update.
                </Typography>
              </div>
              <Button
                variant="ghost"
                size="compact"
                onClick={() =>
                  setDeselectedIds(
                    allSelected
                      ? new Set(affected.map((cs) => cs.id))
                      : new Set(),
                  )
                }
              >
                {allSelected ? "Clear all" : "Select all"}
              </Button>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {affected.map((cs) => (
                <div
                  key={cs.id}
                  className="rounded-md border border-[var(--border-base)] px-3 py-2"
                >
                  <Checkbox
                    checked={!deselectedIds.has(cs.id)}
                    onCheckedChange={(checked) =>
                      toggleCallSite(cs.id, checked === true)
                    }
                    disabled={applying}
                    label={cs.displayName}
                    helperText={domainLabelFor(cs.domain)}
                  />
                </div>
              ))}
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Typography
            variant="body-small-default"
            as="p"
            className="mr-auto self-center text-[color:var(--content-secondary)]"
          >
            {selectedIds.length} {overrideNoun} will change
          </Typography>
          <Button
            variant="ghost"
            size="compact"
            onClick={onClose}
            disabled={applying}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={
              !source || !target || selectedIds.length === 0 || applying
            }
            onClick={() => void handleApply()}
          >
            {applying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              `Apply to ${selectedIds.length} ${overrideNoun}`
            )}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
