import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@vellumai/design-library/components/input";
import {
  Select,
  type SelectOption,
} from "@vellumai/design-library/components/select";
import { toast } from "@vellumai/design-library/components/toast";

import {
  ACP_SELECTABLE_MODELS,
  isAcpSelectableModel,
} from "@/assistant/acp-model-options";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ByoServiceCard } from "@/components/byo-service-card";
import { SaveButton } from "@/components/service-form-controls";
import { CUSTOM_SENTINEL } from "@/domains/settings/ai/call-site-helpers";
import {
  configGetOptions,
  configGetSetQueryData,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useDraftOverride } from "@/hooks/use-draft-override";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { useAssistantScopedSupportsAcpModelSwitching } from "@/lib/backwards-compat/acp-model-switching";
import { captureError } from "@/lib/sentry/capture-error";

/**
 * Picks the model every new coding-agent session starts on, saved as
 * `acp.defaultModel`.
 *
 * It is the bottom rung of the daemon's resolution ladder, so an explicit
 * spawn request, a conversation's remembered choice, and a per-agent setting
 * all outrank it. Leaving it on the agent's default writes `null`, which
 * delegates model selection to the adapter.
 */
export function CodingAgentsCard() {
  const assistantId = useActiveAssistantId();
  // The key remounts the body on an assistant switch, so an unsaved draft
  // never carries over and gets saved onto another assistant's config.
  return <CodingAgentsCardBody key={assistantId} assistantId={assistantId} />;
}

function CodingAgentsCardBody({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();
  const supportsModelSwitching =
    useAssistantScopedSupportsAcpModelSwitching(assistantId);

  const { data: daemonConfig } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    enabled: isOrgReady,
    staleTime: 30_000,
  });

  const configMutation = useConfigPatchMutation({
    // The cache key comes from the mutation VARIABLES, not the render-time
    // id: TanStack rebinds a pending mutation's options on rerender, so a
    // captured id would file this assistant's response under whichever
    // assistant the user switched to while the PATCH was in flight.
    onSuccess: (data, variables) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: variables.path.assistant_id } },
        data,
      );
    },
  });

  const serverDefaultModel = daemonConfig?.acp?.defaultModel?.trim() || null;

  const [saving, setSaving] = useState(false);
  const [defaultModel, setDraftDefaultModel] = useDraftOverride<string | null>(
    serverDefaultModel,
  );
  // Sticks the custom row to the trigger while its input is still empty,
  // which is the one moment the draft cannot say so for itself.
  const [customPicked, setCustomPicked] = useState(false);

  // A stored model that changes under the card (another client, an edited
  // config file) decides the row again. Without this the trigger stays on the
  // custom row while the select shows a listed alias. An edit in progress
  // outranks it: an empty custom draft cannot re-derive its own row, so
  // resetting mid-edit would take the input away and blank the trigger.
  const hasDraft = defaultModel !== serverDefaultModel;
  const [prevServerModel, setPrevServerModel] = useState(serverDefaultModel);
  if (prevServerModel !== serverDefaultModel) {
    setPrevServerModel(serverDefaultModel);
    if (!hasDraft) {
      setCustomPicked(false);
    }
  }

  const hasCustomValue =
    Boolean(defaultModel) && !isAcpSelectableModel(defaultModel);
  const showsCustomInput = customPicked || hasCustomValue;
  // An empty draft matches no option, so the trigger falls back to the
  // agent-default row rather than rendering blank.
  const selectValue = showsCustomInput ? CUSTOM_SENTINEL : defaultModel || null;

  // Blank custom text means "no default", so clearing the input is the same
  // choice as picking the agent-default row.
  const nextDefaultModel = defaultModel?.trim() || null;
  // An empty custom field is not a choice: saving it would erase a stored
  // default the user never asked to clear. Clearing stays one row away.
  const saveDisabled =
    saving ||
    nextDefaultModel === serverDefaultModel ||
    (showsCustomInput && nextDefaultModel === null);

  const modelOptions = useMemo(
    (): SelectOption<string>[] => [
      { value: null, label: t("codingAgentsCard.agentDefaultOption") },
      ...ACP_SELECTABLE_MODELS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
      {
        value: CUSTOM_SENTINEL,
        label: t("codingAgentsCard.customModelOption"),
        sticky: true,
      },
    ],
    [t],
  );

  const handleSelect = useCallback(
    (value: string) => {
      if (value === CUSTOM_SENTINEL) {
        setCustomPicked(true);
        if (!hasCustomValue) {
          setDraftDefaultModel("");
        }
        return;
      }
      setCustomPicked(false);
      setDraftDefaultModel(value);
    },
    [hasCustomValue, setDraftDefaultModel],
  );

  const handleSelectNone = useCallback(() => {
    setCustomPicked(false);
    setDraftDefaultModel(null);
  }, [setDraftDefaultModel]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await configMutation.mutateAsync({
        path: { assistant_id: assistantId },
        body: { acp: { defaultModel: nextDefaultModel } },
      });
    } catch (error) {
      toast.error(t("codingAgentsCard.configUpdateFailedToast"));
      captureError(error, { context: "patch_daemon_config" });
      setSaving(false);
      return;
    }
    setSaving(false);
    toast.success(t("codingAgentsCard.savedToast"));
  }, [assistantId, configMutation, nextDefaultModel, t]);

  if (!supportsModelSwitching) {
    return null;
  }

  return (
    <ByoServiceCard
      id="coding-agents"
      title={t("codingAgentsCard.title")}
      subtitle={t("codingAgentsCard.subtitle")}
    >
      <div className="space-y-4">
        <Select
          label={t("codingAgentsCard.modelLabel")}
          value={selectValue}
          onChange={handleSelect}
          onSelectNone={handleSelectNone}
          options={modelOptions}
        />

        {showsCustomInput && (
          <div className="space-y-1">
            <Input
              label={t("codingAgentsCard.customModelLabel")}
              value={defaultModel ?? ""}
              onChange={(e) => setDraftDefaultModel(e.target.value)}
              placeholder={t("codingAgentsCard.customModelPlaceholder")}
              fullWidth
            />
            <p className="text-body-small-lighter text-[var(--content-tertiary)]">
              {t("codingAgentsCard.customModelHint")}
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <SaveButton onClick={handleSave} disabled={saveDisabled} />
          {saving && (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
          )}
        </div>
      </div>
    </ByoServiceCard>
  );
}
