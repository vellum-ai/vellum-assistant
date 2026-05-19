
import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Menu } from "@vellum/design-library/components/menu";
import {
  deleteConversationOverride,
  getConversationOverride,
  getGlobalThresholds,
  setConversationOverride,
} from "@/domains/chat/lib/threshold-api.js";
import {
  THRESHOLD_PRESETS,
  overrideAction,
  presetFromThreshold,
  type ThresholdPreset,
} from "@/domains/chat/lib/threshold-presets.js";

interface Props {
  assistantId: string;
  conversationId: string | undefined;
}

export function ComposerThresholdPicker({ assistantId, conversationId }: Props) {
  const [activePreset, setActivePreset] = useState<ThresholdPreset>(THRESHOLD_PRESETS[1]!);
  const [globalInteractive, setGlobalInteractive] = useState<string | null>(null);
  const [isOverride, setIsOverride] = useState(false);

  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (!assistantId) return;
    let cancelled = false;

    (async () => {
      try {
        const thresholds = await getGlobalThresholds(assistantId);
        if (cancelled) return;
        setGlobalInteractive(thresholds.interactive);

        if (!conversationId) {
          setActivePreset(presetFromThreshold(thresholds.interactive));
          setIsOverride(false);
          return;
        }

        const override = await getConversationOverride(assistantId, conversationId);
        if (cancelled) return;
        if (override !== null) {
          setActivePreset(presetFromThreshold(override));
          setIsOverride(true);
        } else {
          setActivePreset(presetFromThreshold(thresholds.interactive));
          setIsOverride(false);
        }
      } catch {
        if (cancelled) return;
      }
    })();

    return () => { cancelled = true; };
  }, [assistantId, conversationId]);

  const handleSelect = useCallback(
    async (preset: ThresholdPreset) => {
      if (!conversationId || globalInteractive === null) return;

      const action = overrideAction(preset, globalInteractive);
      setActivePreset(preset);
      setIsOverride(action.action === "set");

      try {
        if (action.action === "set") {
          await setConversationOverride(assistantId, conversationId, action.threshold);
        } else {
          await deleteConversationOverride(assistantId, conversationId);
        }
      } catch {
        if (conversationIdRef.current !== conversationId) return;
        const currentOverride = await getConversationOverride(assistantId, conversationId).catch(() => null);
        if (currentOverride !== null) {
          setActivePreset(presetFromThreshold(currentOverride));
          setIsOverride(true);
        } else {
          setActivePreset(presetFromThreshold(globalInteractive));
          setIsOverride(false);
        }
      }
    },
    [assistantId, conversationId, globalInteractive],
  );

  const disabled = !conversationId || globalInteractive === null;
  const Icon = activePreset.icon;
  const effectiveGlobal = globalInteractive ?? "medium";

  return (
    <Menu.Root>
      <Menu.Trigger>
        <Button
          variant="ghost"
          disabled={disabled}
          leftIcon={<Icon className="h-3.5 w-3.5" />}
          rightIcon={<ChevronDown className="h-3 w-3" />}
          aria-label={`Risk tolerance: ${activePreset.label}`}
          className={`text-body-medium-lighter ${isOverride ? "[--vbtn-fg:var(--primary-base)]" : "[--vbtn-fg:var(--content-secondary)]"}`}
        >
          {activePreset.label}
        </Button>
      </Menu.Trigger>
      <Menu.Content side="top" align="start">
        {THRESHOLD_PRESETS.map((preset) => {
          const isActive = preset.id === activePreset.id;
          const PresetIcon = preset.icon;
          const isDefault =
            !isOverride && preset.riskThreshold === effectiveGlobal;
          return (
            <Menu.Item
              key={preset.id}
              onSelect={() => handleSelect(preset)}
              leftIcon={<PresetIcon className="h-3.5 w-3.5" />}
              className={`whitespace-nowrap text-body-medium-lighter ${isActive ? "bg-[var(--surface-active)] text-[var(--content-emphasised)]" : "text-[var(--content-secondary)]"}`}
              shortcut={isActive ? <Check className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" /> : undefined}
              title={preset.description}
            >
              {preset.label}
              {isDefault && (
                <span className="ml-1 text-[var(--content-tertiary)]">(default)</span>
              )}
            </Menu.Item>
          );
        })}
      </Menu.Content>
    </Menu.Root>
  );
}
