import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { toast } from "@vellum/design-library/components/toast";

import {
  modelImagegenPutMutation,
  secretsPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { getLocalSetting, removeLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { assertProvisionSuccess } from "@/domains/settings/ai/ai-utils";

import {
  useDaemonConfig,
  invalidateDaemonConfig,
  daemonConfigPatchMutation,
} from "@/domains/settings/ai/use-daemon-config";
import { ServiceCard, SaveButton, ResetButton } from "@/domains/settings/ai/ai-shared-ui";
import type { ServiceMode } from "@/domains/settings/ai/ai-types";
import { isServiceMode } from "@/domains/settings/ai/ai-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AVAILABLE_IMAGE_GEN_MODELS = [
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
] as const;

const IMAGE_GEN_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gemini-3.1-flash-image-preview": "Nano Banana 2",
  "gemini-3-pro-image-preview": "Nano Banana Pro",
};

// ---------------------------------------------------------------------------
// Local-storage keys
// ---------------------------------------------------------------------------

const LS_IMAGE_GEN_MODE = "vellum:ai:imageGenMode";
const LS_IMAGE_GEN_MODEL = "vellum:ai:imageGenModel";
const LS_IMAGE_GEN_CREDENTIAL = "vellum:ai:geminiKey";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImageGenerationCard() {
  const queryClient = useQueryClient();
  const { assistantId, config } = useDaemonConfig();

  // Derive "saved" state from daemon config
  const serverMode = config.services?.["image-generation"]?.mode;
  const savedMode: ServiceMode =
    isServiceMode(serverMode) ? serverMode : "your-own";

  // Draft state
  const [mode, setMode] = useState<ServiceMode>(() => {
    const local = getLocalSetting(LS_IMAGE_GEN_MODE, "");
    return isServiceMode(local) ? local : savedMode;
  });
  const [model, setModel] = useState(() =>
    getLocalSetting(LS_IMAGE_GEN_MODEL, "gemini-3.1-flash-image-preview"),
  );
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  // Sync draft from server on first load
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!config.services && !hydratedRef.current) return;
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (isServiceMode(serverMode)) setMode(serverMode);
  }, [config.services, serverMode]);

  // Mutations
  const patchConfig = useMutation(daemonConfigPatchMutation());
  const provisionSecret = useMutation(secretsPostMutation());

  const putImageGenModel = useMutation(modelImagegenPutMutation());

  const handleSave = async () => {
    if (!assistantId) {
      toast.error("Assistant not ready. Please try again.");
      return;
    }
    setSaving(true);
    const trimmed = apiKey.trim();
    const hasUserKey = mode === "your-own" && trimmed.length > 0;
    let remoteSaved = false;
    try {
      if (hasUserKey) {
        const result = await provisionSecret.mutateAsync({
          path: { assistant_id: assistantId },
          body: { value: trimmed, type: "api_key", name: "gemini" },
        });
        assertProvisionSuccess(result);
      }
      await patchConfig.mutateAsync({
        path: { assistant_id: assistantId },
        body: {
          services: { "image-generation": { mode } },
        },
      });
      await putImageGenModel.mutateAsync({
        path: { assistant_id: assistantId },
        body: { modelId: model },
      });
      remoteSaved = true;
      invalidateDaemonConfig(queryClient, assistantId);
    } catch (error) {
      captureError(error, { context: "settings-ai-image-gen-save" });
      if (!remoteSaved) {
        toast.error("Failed to save image generation settings. Please try again.");
      }
    }
    if (!remoteSaved) {
      setSaving(false);
      return;
    }
    try {
      setLocalSetting(LS_IMAGE_GEN_MODE, mode);
      setLocalSetting(LS_IMAGE_GEN_MODEL, model);
      if (hasUserKey) {
        setLocalSetting(LS_IMAGE_GEN_CREDENTIAL, trimmed);
        setApiKey("");
      }
      toast.success("Image generation settings saved.");
    } catch (err) {
      captureError(err, { context: "settings-ai-image-gen-persist-local" });
      toast.error("Saved, but local preferences could not be written.");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    removeLocalSetting(LS_IMAGE_GEN_CREDENTIAL);
    setApiKey("");
    setModel("gemini-3.1-flash-image-preview");
    setLocalSetting(LS_IMAGE_GEN_MODEL, "gemini-3.1-flash-image-preview");
  };

  return (
    <ServiceCard
      title="Image Generation"
      subtitle="Configure which model your assistant uses to generate images"
      mode={mode}
      onModeChange={setMode}
    >
      {mode === "managed" ? (
        <div className="space-y-3">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            Active Model
          </label>
          <div className="flex items-end gap-3">
            <Dropdown
              className="flex-1"
              value={model}
              onChange={setModel}
              options={AVAILABLE_IMAGE_GEN_MODELS.map((m) => ({
                value: m,
                label: IMAGE_GEN_MODEL_DISPLAY_NAMES[m] ?? m,
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
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter your Gemini API key"
            fullWidth
          />

          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Active Model
            </label>
            <Dropdown
              value={model}
              onChange={setModel}
              options={AVAILABLE_IMAGE_GEN_MODELS.map((m) => ({
                value: m,
                label: IMAGE_GEN_MODEL_DISPLAY_NAMES[m] ?? m,
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
