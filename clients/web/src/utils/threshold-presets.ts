import {
  Lock,
  Shield,
  ShieldCheck,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";

import type { AssistantPermissionsThresholdsGetResponse } from "@/generated/gateway/types.gen";

// The gateway schema repeats this enum inline on every thresholds field;
// the interactive threshold is the anchor the app derives it from.
export type RiskThreshold =
  AssistantPermissionsThresholdsGetResponse["interactive"];

export interface ThresholdPreset {
  id: string;
  label: string;
  riskThreshold: RiskThreshold;
  description: string;
  icon: LucideIcon;
}

export const THRESHOLD_PRESETS: ThresholdPreset[] = [
  {
    id: "strict",
    label: "Strict",
    riskThreshold: "none",
    description:
      "Always ask before acting. Only actions your Trust Rules allow run on their own.",
    icon: Lock,
  },
  {
    id: "conservative",
    label: "Conservative",
    riskThreshold: "low",
    description:
      "Auto-approve low-risk actions like reading files and web searches.",
    icon: ShieldCheck,
  },
  {
    id: "relaxed",
    label: "Relaxed",
    riskThreshold: "medium",
    description:
      "Auto-approve low and medium-risk actions like writing files in your workspace.",
    icon: Shield,
  },
  {
    id: "fullAccess",
    label: "Full access",
    riskThreshold: "high",
    description:
      "Auto-approve all actions, including high-risk and unrecognized commands. Actions your Trust Rules block are still refused.",
    icon: ShieldOff,
  },
];

export function presetFromThreshold(threshold: string): ThresholdPreset {
  const match = THRESHOLD_PRESETS.find((p) => p.riskThreshold === threshold);
  return match ?? THRESHOLD_PRESETS[1]!;
}

/**
 * Determine whether selecting a preset in the per-conversation picker should
 * set an explicit override or clear the existing one (falling back to the
 * global interactive threshold).
 *
 * Matches the macOS ComposerThresholdPicker logic: the "Conservative" option
 * in the composer means "no override / use whatever the global setting is",
 * so any preset whose riskThreshold matches the global interactive threshold
 * triggers a clear, not a set.
 */
export function overrideAction(
  preset: ThresholdPreset,
  globalInteractive: string,
): { action: "set"; threshold: RiskThreshold } | { action: "clear" } {
  if (preset.riskThreshold === globalInteractive) {
    return { action: "clear" };
  }
  return { action: "set", threshold: preset.riskThreshold };
}
