import { ChevronDown, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AvailableSound } from "@/domains/settings/api/sounds";
import {
    defaultSoundsConfig,
    displayLabelForFilename,
    SOUND_EVENT_DISPLAY_NAMES,
    SOUND_EVENT_IDS,
    type SoundEventConfig,
    type SoundEventId,
} from "@/domains/settings/types/sounds";
import { getSoundManager } from "@/domains/settings/utils/sound-manager";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  soundsAvailableGetOptions,
  soundsConfigGetOptions,
  soundsConfigGetSetQueryData,
  soundsConfigPutMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { SoundsConfigGetResponse } from "@/generated/daemon/types.gen";
import { Card } from "@vellumai/design-library/components/card";
import { Toggle } from "@vellumai/design-library/components/toggle";

type SoundsConfig = SoundsConfigGetResponse;

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div>
        <div className="text-body-medium-lighter text-[var(--content-default)]">
          {label}
        </div>
        {description && (
          <div className="text-body-small-default text-[var(--content-tertiary)]">
            {description}
          </div>
        )}
      </div>
      <Toggle
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        label={label}
      />
    </div>
  );
}

function Divider() {
  return <div className="border-t border-[var(--border-base)]" />;
}

function SoundEventRow({
  event,
  eventConfig,
  availableSounds,
  globalEnabled,
  onToggle,
  onAddSound,
  onRemoveSound,
  onPreview,
}: {
  event: SoundEventId;
  eventConfig: SoundEventConfig;
  availableSounds: AvailableSound[];
  globalEnabled: boolean;
  onToggle: (enabled: boolean) => void;
  onAddSound: (filename: string) => void;
  onRemoveSound: (filename: string) => void;
  onPreview: (filename: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const remaining = availableSounds.filter(
    (s) => !eventConfig.sounds.includes(s.filename),
  );
  const allAdded = availableSounds.length > 0 && remaining.length === 0;

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-body-medium-lighter text-[var(--content-default)]">
          {SOUND_EVENT_DISPLAY_NAMES[event]}
        </span>
        <Toggle
          checked={eventConfig.enabled}
          disabled={!globalEnabled}
          onChange={onToggle}
          label={`Enable ${SOUND_EVENT_DISPLAY_NAMES[event]}`}
        />
      </div>

      {eventConfig.enabled && (
        <div className="mt-2 space-y-1 pl-2">
          {eventConfig.sounds.length === 0 ? (
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              Default Blip
            </p>
          ) : (
            eventConfig.sounds.map((filename) => (
              <div
                key={filename}
                className="flex items-center justify-between gap-2"
              >
                <span
                  className="truncate text-body-small-default text-[var(--content-secondary)]"
                  title={filename}
                >
                  {displayLabelForFilename(filename)}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onPreview(filename)}
                    className="inline-flex items-center rounded-md px-1.5 py-0.5 text-body-small-default text-[var(--content-tertiary)] hover:bg-[var(--surface-base)] dark:text-[var(--content-disabled)] dark:hover:bg-[var(--ghost-hover)]"
                    aria-label={`Preview ${filename}`}
                  >
                    <Play className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveSound(filename)}
                    className="inline-flex items-center rounded-md px-1.5 py-0.5 text-body-small-default text-[var(--content-tertiary)] hover:bg-[var(--surface-base)] dark:text-[var(--content-disabled)] dark:hover:bg-[var(--ghost-hover)]"
                    aria-label={`Remove ${filename}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))
          )}

          {availableSounds.length === 0 ? (
            <p className="text-body-small-default italic text-[var(--content-disabled)]">
              No sound files yet. Drop audio files into data/sounds/ in your
              workspace.
            </p>
          ) : allAdded ? (
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border-base)] bg-white px-2 py-1 text-body-small-default text-[var(--content-disabled)] disabled:cursor-not-allowed dark:bg-[var(--surface-lift)] dark:text-[var(--content-tertiary)]"
            >
              All sounds added
            </button>
          ) : (
            <div className="relative inline-block">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border-base)] bg-white px-2 py-1 text-body-small-default text-[var(--content-default)] hover:bg-[var(--surface-base)] dark:bg-[var(--surface-lift)] dark:hover:bg-[var(--ghost-hover)]"
              >
                Add sound
                <ChevronDown className="h-3 w-3" />
              </button>
              {pickerOpen && (
                <div
                  className="absolute left-0 z-10 mt-1 max-h-64 w-56 overflow-auto rounded-md border border-[var(--border-base)] bg-white p-1 shadow-lg dark:bg-[var(--surface-lift)]"
                  onMouseLeave={() => setPickerOpen(false)}
                >
                  {remaining.map((s) => (
                    <button
                      key={s.filename}
                      type="button"
                      onClick={() => {
                        onAddSound(s.filename);
                        setPickerOpen(false);
                      }}
                      className="block w-full truncate rounded px-2 py-1 text-left text-body-small-default text-[var(--content-default)] hover:bg-[var(--surface-base)] dark:hover:bg-[var(--ghost-hover)]"
                      title={s.filename}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SoundsPage() {
  const queryClient = useQueryClient();
  const assistantId = useActiveAssistantId();

  const configOptions = useMemo(
    () => soundsConfigGetOptions({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const availableOptions = useMemo(
    () => soundsAvailableGetOptions({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  const { data: rawConfig } = useQuery(configOptions);

  const { data: availableRaw } = useQuery(availableOptions);

  const config = rawConfig ?? defaultSoundsConfig();
  const available = availableRaw?.sounds ?? [];

  const sdkOptions = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  const saveMutation = useMutation({
    ...soundsConfigPutMutation(sdkOptions),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: configOptions.queryKey });
      const previous = queryClient.getQueryData(configOptions.queryKey);
      soundsConfigGetSetQueryData(queryClient, sdkOptions, variables.body);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous !== undefined) {
        soundsConfigGetSetQueryData(queryClient, sdkOptions, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configOptions.queryKey });
    },
  });

  useEffect(() => {
    const manager = getSoundManager();
    manager.setAssistantId(assistantId || null);
    manager.setConfig(config);
    manager.setFeatureEnabled(true);
    return () => {
      manager.setFeatureEnabled(false);
    };
  }, [assistantId, config]);

  const updateConfig = useCallback(
    (producer: (prev: SoundsConfig) => SoundsConfig) => {
      const prev =
        queryClient.getQueryData(configOptions.queryKey) ??
        defaultSoundsConfig();
      const next = producer(prev);
      saveMutation.mutate({
        path: { assistant_id: assistantId },
        body: next,
      });
    },
    [assistantId, configOptions.queryKey, queryClient, saveMutation],
  );

  const setGlobalEnabled = (enabled: boolean) => {
    updateConfig((prev) => ({ ...prev, globalEnabled: enabled }));
  };
  const commitVolume = (volume: number) => {
    updateConfig((prev) => ({ ...prev, volume }));
  };

  const [draftVolume, setDraftVolume] = useState<number | null>(null);
  const displayVolume = draftVolume ?? config.volume;

  const setEventEnabled = (event: SoundEventId, enabled: boolean) => {
    updateConfig((prev) => ({
      ...prev,
      events: {
        ...prev.events,
        [event]: {
          ...(prev.events[event] ?? { enabled: false, sounds: [] }),
          enabled,
        },
      },
    }));
  };

  const addSoundToEvent = (event: SoundEventId, filename: string) => {
    updateConfig((prev) => {
      const current = prev.events[event] ?? { enabled: true, sounds: [] };
      if (current.sounds.includes(filename)) return prev;
      return {
        ...prev,
        events: {
          ...prev.events,
          [event]: { ...current, sounds: [...current.sounds, filename] },
        },
      };
    });
  };

  const removeSoundFromEvent = (event: SoundEventId, filename: string) => {
    updateConfig((prev) => {
      const current = prev.events[event];
      if (!current) return prev;
      return {
        ...prev,
        events: {
          ...prev.events,
          [event]: {
            ...current,
            sounds: current.sounds.filter((s) => s !== filename),
          },
        },
      };
    });
  };

  const previewDefault = () => {
    void getSoundManager().previewFallbackBlip(config.volume);
  };
  const previewFile = (filename: string) => {
    void getSoundManager().previewSound(filename, config.volume);
  };

  return (
    <div className="space-y-6">
      <Card>
        <ToggleRow
          label="Enable sound effects"
          description="Master switch for every event-driven sound."
          checked={config.globalEnabled}
          onChange={setGlobalEnabled}
        />
        <Divider />
        <div className="flex items-center gap-3 py-3">
          <span className="text-body-medium-lighter text-[var(--content-default)]">
            Volume
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={displayVolume}
            onChange={(e) => setDraftVolume(parseFloat(e.target.value))}
            onPointerUp={(e) => {
              const next = parseFloat(e.currentTarget.value);
              setDraftVolume(null);
              if (next !== config.volume) commitVolume(next);
            }}
            onKeyUp={(e) => {
              const next = parseFloat(e.currentTarget.value);
              setDraftVolume(null);
              if (next !== config.volume) commitVolume(next);
            }}
            onBlur={(e) => {
              const next = parseFloat(e.currentTarget.value);
              setDraftVolume(null);
              if (next !== config.volume) commitVolume(next);
            }}
            className="h-1 w-48 cursor-pointer"
            disabled={!config.globalEnabled}
            aria-label="Sound effect volume"
          />
          <span className="tabular-nums text-body-small-default text-[var(--content-tertiary)]">
            {Math.round(displayVolume * 100)}%
          </span>
        </div>
        <Divider />
        <div className="flex items-center justify-between py-3">
          <span className="text-body-medium-lighter text-[var(--content-default)]">
            Preview default blip
          </span>
          <button
            type="button"
            onClick={previewDefault}
            disabled={!config.globalEnabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-white px-3 py-1.5 text-body-medium-lighter text-[var(--content-default)] hover:bg-[var(--surface-base)] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[var(--surface-lift)] dark:hover:bg-[var(--ghost-hover)]"
          >
            <Play className="h-3.5 w-3.5" />
            Preview
          </button>
        </div>
      </Card>

      <Card>
        <div className="pb-2">
          <h3 className="text-title-small text-[var(--content-default)]">
            Sound Events
          </h3>
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            Add one or more sounds per event. When multiple are configured, one
            plays at random.
          </p>
        </div>
        <div className="divide-y divide-[var(--border-base)]">
          {SOUND_EVENT_IDS.map((event) => (
            <SoundEventRow
              key={event}
              event={event}
              eventConfig={
                config.events[event] ?? { enabled: false, sounds: [] }
              }
              availableSounds={available}
              globalEnabled={config.globalEnabled}
              onToggle={(enabled) => setEventEnabled(event, enabled)}
              onAddSound={(filename) => addSoundToEvent(event, filename)}
              onRemoveSound={(filename) =>
                removeSoundFromEvent(event, filename)
              }
              onPreview={(filename) => previewFile(filename)}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
