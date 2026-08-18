import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Checkbox } from "@vellumai/design-library/components/checkbox";
import { Select } from "@vellumai/design-library/components/select";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";
import { toast } from "@vellumai/design-library/components/toast";

import {
  profilePickerLabel,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import {
  effectiveCallSiteProfile,
  type CallSiteEffectiveProfile,
} from "@/domains/settings/ai/call-site-helpers";
import { useLlmConfigPatch } from "@/domains/settings/ai/use-llm-config-patch";
import { useSupportsCompleteProfileSnapshots } from "@/lib/backwards-compat/complete-profile-snapshots";
import {
  profileDisplayLabel,
  type ProfileWithName,
} from "@/domains/settings/ai/utils";
import type {
  CallSiteOverrideDraft,
  ConfigGetResponse,
  ConfigLlmCallsitesGetResponse,
} from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";
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
 * One-time bulk profile swap over the actions: every selected action that
 * currently runs on the source profile, whether through an explicit
 * override or through its default, is pinned to the target profile as an
 * individual override in a single `PATCH /v1/config`. Acts on persisted
 * state only, so hosts gate the entry point while the editor holds unsaved
 * drafts. Mount per open; selection state does not survive a close.
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
  const { t } = useTranslation("settings");
  const configMutation = useLlmConfigPatch(assistantId);
  // Older assistants live-inherit blank profile fields, so a sparse profile
  // dispatches there and must not be filtered out of the target list.
  const requireOwnProviderAndModel = useSupportsCompleteProfileSnapshots();
  const dispatchOptions = useMemo(
    () => ({ requireOwnProviderAndModel }),
    [requireOwnProviderAndModel],
  );

  // What each action currently runs on. Sites with a provider/model
  // ("Custom") pin reference no profile and stay out.
  const effectiveByCallSite = useMemo(() => {
    const map = new Map<string, CallSiteEffectiveProfile>();
    for (const cs of callSites) {
      const effective = effectiveCallSiteProfile(cs, persistedOverrides[cs.id]);
      if (effective) {
        map.set(cs.id, effective);
      }
    }
    return map;
  }, [callSites, persistedOverrides]);

  // Profiles at least one action currently runs on, in profile order. A
  // default may name a profile missing from the map (it never becomes a
  // source option, so its actions are simply not swappable from here);
  // override names always exist because the config schema validates them.
  const sourceProfiles = useMemo(() => {
    const used = new Set(
      Array.from(effectiveByCallSite.values(), (e) => e.profile),
    );
    return orderedProfiles.filter((p) => used.has(p.name));
  }, [orderedProfiles, effectiveByCallSite]);

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
      callSites.filter(
        (cs) => effectiveByCallSite.get(cs.id)?.profile === source,
      ),
    [callSites, effectiveByCallSite, source],
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
      visibleProfilesForPicker(orderedProfiles, [], dispatchOptions)
        .filter((p) => p.name !== source)
        .map((p) => ({ value: p.name, label: profilePickerLabel(p) })),
    [orderedProfiles, source, dispatchOptions],
  );

  const sourceLabel = profileDisplayLabel(orderedProfiles, source);
  const targetLabel = profileDisplayLabel(orderedProfiles, target);

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
        t("bulkOverrideSwapModal.successToast", {
          count: selectedIds.length,
          targetLabel,
        }),
      );
      onApplied();
      onClose();
    } catch (error) {
      // A 400 is the server's verdict on the selection itself (e.g. a
      // profile that no longer exists). Show it verbatim and skip Sentry.
      const serverMessage = badRequestMessage(error);
      toast.error(
        serverMessage ?? t("bulkOverrideSwapModal.updateFailedToast"),
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
          <Modal.Title>{t("bulkOverrideSwapModal.title")}</Modal.Title>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          <Typography variant="body-medium-default" as="p">
            {t("bulkOverrideSwapModal.intro")}
          </Typography>

          <div className="grid grid-cols-2 gap-3">
            <Select
              id="bulk-swap-source"
              label={t("bulkOverrideSwapModal.currentlyUsingLabel")}
              value={source}
              onChange={handleSourceChange}
              options={sourceOptions}
            />
            <Select
              id="bulk-swap-target"
              label={t("bulkOverrideSwapModal.changeToLabel")}
              value={target}
              onChange={setTarget}
              options={targetOptions}
              placeholder={t("bulkOverrideSwapModal.targetPlaceholder")}
            />
          </div>

          <Notice tone="info" title={t("bulkOverrideSwapModal.noticeTitle")}>
            {t("bulkOverrideSwapModal.noticeBody", { sourceLabel })}
          </Notice>

          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <div>
                <Typography variant="body-medium-default" as="p">
                  {t("bulkOverrideSwapModal.affectedSummary", {
                    count: affected.length,
                    profile: sourceLabel,
                  })}
                </Typography>
                <Typography
                  variant="body-small-default"
                  as="p"
                  className="text-[color:var(--content-secondary)]"
                >
                  {t("bulkOverrideSwapModal.chooseActions")}
                </Typography>
              </div>
              <Button
                variant="ghost"
                onClick={() =>
                  setDeselectedIds(
                    allSelected
                      ? new Set(affected.map((cs) => cs.id))
                      : new Set(),
                  )
                }
              >
                {allSelected
                  ? t("bulkOverrideSwapModal.clearAll")
                  : t("bulkOverrideSwapModal.selectAll")}
              </Button>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {affected.map((cs) => (
                <div
                  key={cs.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-base)] px-3 py-2"
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
                  <span className="shrink-0 text-body-small-default text-[color:var(--content-tertiary)]">
                    {effectiveByCallSite.get(cs.id)?.via === "override"
                      ? t("bulkOverrideSwapModal.viaOverride")
                      : t("bulkOverrideSwapModal.viaDefault")}
                  </span>
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
            {t("bulkOverrideSwapModal.willChange", {
              count: selectedIds.length,
            })}
          </Typography>
          <Button variant="ghost" onClick={onClose} disabled={applying}>
            {t("bulkOverrideSwapModal.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={
              !source || !target || selectedIds.length === 0 || applying
            }
            onClick={() => void handleApply()}
          >
            {applying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t("bulkOverrideSwapModal.applyTo", {
                count: selectedIds.length,
              })
            )}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
