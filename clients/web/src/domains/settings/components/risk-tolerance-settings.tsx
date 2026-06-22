import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
    getGlobalThresholds,
    setGlobalThresholds,
} from "@/lib/threshold-api";
import {
    THRESHOLD_PRESETS,
    presetFromThreshold,
} from "@/utils/threshold-presets";
import { Card } from "@vellumai/design-library/components/card";
import { Dropdown } from "@vellumai/design-library/components/dropdown";

function Divider() {
  return (
    <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
  );
}

const PRESET_OPTIONS = THRESHOLD_PRESETS.map((p) => ({
  value: p.id,
  label: p.label,
  icon: <p.icon className="h-3.5 w-3.5" />,
}));

export function RiskToleranceSettings() {
  const assistantId = useActiveAssistantId();

  const queryClient = useQueryClient();
  const { data: thresholds, isError: loadError } = useQuery({
    queryKey: ["thresholds", assistantId],
    queryFn: () => getGlobalThresholds(assistantId),
    staleTime: 30_000,
  });

  const [interactivePresetId, setInteractivePresetId] = useState<string>("relaxed");
  const [autonomousPresetId, setAutonomousPresetId] = useState<string>("conservative");
  const [headlessPresetId, setHeadlessPresetId] = useState<string>("strict");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const hasUserInteracted = useRef(false);
  const [hasLoadedInitial, setHasLoadedInitial] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFlushRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!thresholds || hasUserInteracted.current) return;
    setInteractivePresetId(presetFromThreshold(thresholds.interactive).id);
    setAutonomousPresetId(presetFromThreshold(thresholds.autonomous).id);
    setHeadlessPresetId(presetFromThreshold(thresholds.headless).id);
    setHasLoadedInitial(true);
  }, [thresholds]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        pendingFlushRef.current?.();
        pendingFlushRef.current = null;
      }
    };
  }, []);

  const persistThresholds = useCallback(
    (interactiveId: string, autonomousId: string, headlessId: string) => {
      if (!assistantId || !hasLoadedInitial) return;
      const interactive = THRESHOLD_PRESETS.find((p) => p.id === interactiveId)?.riskThreshold;
      const autonomous = THRESHOLD_PRESETS.find((p) => p.id === autonomousId)?.riskThreshold;
      const headless = THRESHOLD_PRESETS.find((p) => p.id === headlessId)?.riskThreshold;
      if (!interactive || !autonomous || !headless) return;
      setGlobalThresholds(assistantId, { interactive, autonomous, headless })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ["thresholds", assistantId] });
        })
        .catch(() => {
          // Silent — optimistic update stays; user can retry by changing again
        });
    },
    [assistantId, hasLoadedInitial, queryClient],
  );

  const scheduleSave = useCallback(
    (interactiveId: string, autonomousId: string, headlessId: string) => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
      pendingFlushRef.current = () =>
        persistThresholds(interactiveId, autonomousId, headlessId);
      saveTimerRef.current = setTimeout(() => {
        pendingFlushRef.current?.();
        saveTimerRef.current = null;
        pendingFlushRef.current = null;
      }, 500);
    },
    [persistThresholds],
  );

  const handleInteractiveChange = useCallback(
    (presetId: string) => {
      hasUserInteracted.current = true;
      setInteractivePresetId(presetId);
      scheduleSave(presetId, autonomousPresetId, headlessPresetId);
    },
    [autonomousPresetId, headlessPresetId, scheduleSave],
  );

  const handleAutonomousChange = useCallback(
    (presetId: string) => {
      hasUserInteracted.current = true;
      setAutonomousPresetId(presetId);
      scheduleSave(interactivePresetId, presetId, headlessPresetId);
    },
    [interactivePresetId, headlessPresetId, scheduleSave],
  );

  const handleHeadlessChange = useCallback(
    (presetId: string) => {
      hasUserInteracted.current = true;
      setHeadlessPresetId(presetId);
      scheduleSave(interactivePresetId, autonomousPresetId, presetId);
    },
    [interactivePresetId, autonomousPresetId, scheduleSave],
  );

  const interactivePreset = THRESHOLD_PRESETS.find((p) => p.id === interactivePresetId);
  const autonomousPreset = THRESHOLD_PRESETS.find((p) => p.id === autonomousPresetId);
  const headlessPreset = THRESHOLD_PRESETS.find((p) => p.id === headlessPresetId);
  const dropdownsDisabled = !assistantId || !hasLoadedInitial;

  return (
    <Card>
      <h2 className="text-title-medium text-[var(--content-default)]">
        Risk Tolerance
      </h2>
      <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
        Control which actions your assistant can take without asking first. Each
        action is classified by risk level — your tolerance determines which
        levels auto-approve.
      </p>
      {loadError && (
        <p className="mt-2 text-body-small-default text-[var(--system-negative-strong)]">
          Could not load threshold settings. Check your connection and reload.
        </p>
      )}
      <div className="mt-4 space-y-4">
        <div>
          <div className="text-body-medium-default text-[var(--content-default)]">
            Conversations
          </div>
          <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
            When you&apos;re chatting with your assistant directly.
          </p>
          <div className="mt-2" style={{ maxWidth: 280 }}>
            <Dropdown
              value={interactivePresetId}
              onChange={handleInteractiveChange}
              options={PRESET_OPTIONS}
              disabled={dropdownsDisabled}
            />
          </div>
          {interactivePreset && (
            <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
              {interactivePreset.description}
            </p>
          )}
        </div>

        <Divider />

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex items-center gap-1 text-[var(--content-secondary)] hover:text-[var(--content-default)] transition-colors"
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            <span className="text-body-medium-default">Advanced</span>
          </button>

          <div className={advancedOpen ? "mt-4 space-y-4" : "hidden"}>
            <div>
              <div className="text-body-medium-default text-[var(--content-default)]">
                Background
              </div>
              <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
                When your assistant acts without you — scheduled tasks,
                background jobs, and external triggers.
              </p>
              <div className="mt-2" style={{ maxWidth: 280 }}>
                <Dropdown
                  value={autonomousPresetId}
                  onChange={handleAutonomousChange}
                  options={PRESET_OPTIONS}
                  disabled={dropdownsDisabled}
                />
              </div>
              {autonomousPreset && (
                <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
                  {autonomousPreset.description}
                </p>
              )}
            </div>

            <Divider />

            <div>
              <div className="text-body-medium-default text-[var(--content-default)]">
                Headless
              </div>
              <p className="mt-0.5 text-body-small-default text-[var(--content-tertiary)]">
                When triggered externally with no interactive client.
              </p>
              <div className="mt-2" style={{ maxWidth: 280 }}>
                <Dropdown
                  value={headlessPresetId}
                  onChange={handleHeadlessChange}
                  options={PRESET_OPTIONS}
                  disabled={dropdownsDisabled}
                />
              </div>
              {headlessPreset && (
                <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
                  {headlessPreset.description}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
