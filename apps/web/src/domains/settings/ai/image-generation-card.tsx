import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { captureError } from "@/lib/sentry/capture-error";
import { assistantDaemonConfigQueryKey } from "@/lib/sync/query-tags";
import {
    getLocalSetting,
    setLocalSetting,
} from "@/utils/local-settings";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

import type { ServiceMode } from "@/domains/settings/ai/ai-types";
import {
    AVAILABLE_IMAGE_GEN_MODELS,
    IMAGE_GEN_MODEL_DISPLAY_NAMES,
    LS_IMAGE_GEN_MODE,
    LS_IMAGE_GEN_MODEL,
} from "@/domains/settings/ai/ai-types";

import { ResetButton, SaveButton, ServiceCard } from "@/domains/settings/ai/ai-shared-ui";
import { useAssistantId, useDaemonConfigMutation, useDaemonConfigQuery, useProvisionProviderKey } from "@/domains/settings/ai/use-daemon-config";
import { useDraftOverride } from "@/domains/settings/ai/use-draft-override";
import { modelImagegenPut } from "@/generated/daemon/sdk.gen";

export function ImageGenerationCard() {
  const { config: daemonConfig } = useDaemonConfigQuery();
  const { resolveAssistantId } = useAssistantId();
  const queryClient = useQueryClient();
  const configMutation = useDaemonConfigMutation();
  const provisionProviderKey = useProvisionProviderKey();
  // Server value derived from daemon config, falling back to localStorage.
  // Updates automatically when the cache refreshes.
  const serverImageGenMode = useMemo<ServiceMode>(() => {
    if (!daemonConfig) return getLocalSetting(LS_IMAGE_GEN_MODE, "your-own") as ServiceMode;
    const mode = daemonConfig.services?.["image-generation"]?.mode;
    return (mode === "managed" || mode === "your-own" ? mode : getLocalSetting(LS_IMAGE_GEN_MODE, "your-own")) as ServiceMode;
  }, [daemonConfig]);

  const [imageGenMode, setDraftImageGenMode] = useDraftOverride(serverImageGenMode);

  const [imageGenModel, setImageGenModel] = useState(() =>
    getLocalSetting(LS_IMAGE_GEN_MODEL, "gemini-3.1-flash-image-preview"),
  );
  const [imageGenApiKey, setImageGenApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const trimmed = imageGenApiKey.trim();
    const hasUserKey = imageGenMode === "your-own" && trimmed.length > 0;
    try {
      if (hasUserKey) {
        await provisionProviderKey("gemini", trimmed);
      }
      await configMutation.mutateAsync({
        services: { "image-generation": { mode: imageGenMode } },
      }).catch((error) => {
        toast.error("Failed to update assistant configuration. Please try again.");
        captureError(error, { context: "patch_daemon_config" });
        throw error;
      });
      const resolvedId = await resolveAssistantId();
      try {
        await modelImagegenPut({
          path: { assistant_id: resolvedId },
          body: { modelId: imageGenModel },
          throwOnError: true,
        });
      } catch (error) {
        toast.error("Failed to update image generation model. Please try again.");
        captureError(error, { context: "set_image_gen_model" });
        throw error;
      } finally {
        void queryClient.invalidateQueries({
          queryKey: assistantDaemonConfigQueryKey(resolvedId),
        });
      }
    } catch {
      setSaving(false);
      return;
    }
    setSaving(false);
    try {
      setLocalSetting(LS_IMAGE_GEN_MODE, imageGenMode);
      setLocalSetting(LS_IMAGE_GEN_MODEL, imageGenModel);
      if (hasUserKey) {
        setImageGenApiKey("");
      }
      toast.success("Image generation settings saved.");
    } catch (err) {
      captureError(err, { context: "settings-ai-image-gen-persist-local" });
      toast.error("Saved, but local preferences could not be written.");
    }
  }, [
    imageGenApiKey,
    imageGenMode,
    imageGenModel,
    configMutation,
    provisionProviderKey,
    resolveAssistantId,
    queryClient,
  ]);

  const handleReset = useCallback(() => {
    setImageGenApiKey("");
    setImageGenModel("gemini-3.1-flash-image-preview");
    setLocalSetting(LS_IMAGE_GEN_MODEL, "gemini-3.1-flash-image-preview");
  }, []);

  return (
    <ServiceCard
      title="Image Generation"
      subtitle="Configure which model your assistant uses to generate images"
      mode={imageGenMode}
      onModeChange={(m) => setDraftImageGenMode(m)}
    >
      {imageGenMode === "managed" ? (
        <div className="space-y-3">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Active Model
          </label>
          <div className="flex items-end gap-3">
            <Dropdown
              className="flex-1"
              value={imageGenModel}
              onChange={setImageGenModel}
              options={AVAILABLE_IMAGE_GEN_MODELS.map((model) => ({
                value: model,
                label: IMAGE_GEN_MODEL_DISPLAY_NAMES[model] ?? model,
              }))}
            />
            <SaveButton onClick={handleSave} disabled={saving} />
            {saving && (
              <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Input
            label="API Key"
            type="password"
            value={imageGenApiKey}
            onChange={(e) => setImageGenApiKey(e.target.value)}
            placeholder="Enter your Gemini API key"
            fullWidth
          />

          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Active Model
            </label>
            <Dropdown
              value={imageGenModel}
              onChange={setImageGenModel}
              options={AVAILABLE_IMAGE_GEN_MODELS.map((model) => ({
                value: model,
                label: IMAGE_GEN_MODEL_DISPLAY_NAMES[model] ?? model,
              }))}
            />
          </div>

          <div className="flex items-center gap-2">
            <SaveButton onClick={handleSave} disabled={saving} />
            {saving && <Loader2 className="h-4 w-4 animate-spin text-[var(--content-disabled)]" />}
            <ResetButton onClick={handleReset} />
          </div>
        </div>
      )}
    </ServiceCard>
  );
}
