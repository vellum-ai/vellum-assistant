import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { toast } from "@vellum/design-library/components/toast";
import { captureError } from "@/lib/sentry/capture-error";
import {
  removeLocalSetting,
  setLocalSetting,
  getLocalSetting,
} from "@/utils/local-settings";

import type { ServiceMode } from "@/domains/settings/ai/ai-types";
import {
  AVAILABLE_IMAGE_GEN_MODELS,
  IMAGE_GEN_MODEL_DISPLAY_NAMES,
  LS_IMAGE_GEN_CREDENTIAL,
  LS_IMAGE_GEN_MODE,
  LS_IMAGE_GEN_MODEL,
} from "@/domains/settings/ai/ai-types";
import { reconcileFromDaemonConfig } from "@/domains/settings/ai/ai-utils";
import { ServiceCard, SaveButton, ResetButton } from "@/domains/settings/ai/ai-shared-ui";
import { useDaemonConfig } from "@/domains/settings/ai/use-daemon-config";

export function ImageGenerationCard() {
  const {
    config: daemonConfig,
    invalidateConfig,
    provisionProviderKey,
    patchDaemonConfig,
    setImageGenModelOnDaemon,
  } = useDaemonConfig();

  const [saving, setSaving] = useState(false);
  const [imageGenMode, setImageGenMode] = useState<ServiceMode>(
    () => getLocalSetting(LS_IMAGE_GEN_MODE, "your-own") as ServiceMode,
  );
  const [imageGenModel, setImageGenModel] = useState(() =>
    getLocalSetting(LS_IMAGE_GEN_MODEL, "gemini-3.1-flash-image-preview"),
  );
  const [imageGenApiKey, setImageGenApiKey] = useState("");

  // Hydrate from daemon config on first load
  const initialized = useRef(false);
  useEffect(() => {
    if (!daemonConfig || initialized.current) return;
    initialized.current = true;
    const reconciled = reconcileFromDaemonConfig(daemonConfig);
    if (reconciled.imageGenMode) setImageGenMode(reconciled.imageGenMode);
  }, [daemonConfig]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const trimmed = imageGenApiKey.trim();
    const hasUserKey = imageGenMode === "your-own" && trimmed.length > 0;
    let remoteSaved = false;
    try {
      if (hasUserKey) {
        await provisionProviderKey("gemini", trimmed);
      }
      await patchDaemonConfig({
        services: { "image-generation": { mode: imageGenMode } },
      });
      await setImageGenModelOnDaemon(imageGenModel);
      remoteSaved = true;
      invalidateConfig();
    } catch {
      // Errors already surfaced via toast + captureError inside the callees.
    }
    if (!remoteSaved) {
      setSaving(false);
      return;
    }
    try {
      setLocalSetting(LS_IMAGE_GEN_MODE, imageGenMode);
      setLocalSetting(LS_IMAGE_GEN_MODEL, imageGenModel);
      if (hasUserKey) {
        setLocalSetting(LS_IMAGE_GEN_CREDENTIAL, trimmed);
        setImageGenApiKey("");
      }
      toast.success("Image generation settings saved.");
    } catch (err) {
      captureError(err, { context: "settings-ai-image-gen-persist-local" });
      toast.error("Saved, but local preferences could not be written.");
    } finally {
      setSaving(false);
    }
  }, [
    imageGenApiKey,
    imageGenMode,
    imageGenModel,
    patchDaemonConfig,
    provisionProviderKey,
    invalidateConfig,
    setImageGenModelOnDaemon,
  ]);

  const handleReset = useCallback(() => {
    removeLocalSetting(LS_IMAGE_GEN_CREDENTIAL);
    setImageGenApiKey("");
    setImageGenModel("gemini-3.1-flash-image-preview");
    setLocalSetting(LS_IMAGE_GEN_MODEL, "gemini-3.1-flash-image-preview");
  }, []);

  return (
    <ServiceCard
      title="Image Generation"
      subtitle="Configure which model your assistant uses to generate images"
      mode={imageGenMode}
      onModeChange={(m) => setImageGenMode(m)}
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
