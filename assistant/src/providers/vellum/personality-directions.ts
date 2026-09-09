/**
 * Map persisted personality sliders onto hosted-inference direction alphas.
 *
 * Sliders are one-sided around center: 50 is no steer. Values below 50
 * activate the left pole; values above 50 activate the right pole. The
 * GPU server never sees slider ids, only `{ pole: alpha }` in `(0, 1]`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PERSONALITY_DIRECTION_AXES,
  PERSONALITY_SLIDERS_PATH,
} from "../../api/constants/personality-sliders.js";

export {
  PERSONALITY_DIRECTION_AXES,
  PERSONALITY_SLIDERS_PATH,
} from "../../api/constants/personality-sliders.js";

export const HOSTED_STEERING_MODEL = "qwen/qwen3-8b";

export type PersonalityDirections = Record<string, number>;

export function isHostedSteeringModel(model: string): boolean {
  return model === HOSTED_STEERING_MODEL;
}

function clampSlider(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

export function mapPersonalitySlidersToDirections(
  values: Record<string, number> | null | undefined,
): PersonalityDirections | undefined {
  if (!values) {
    return undefined;
  }
  const directions: PersonalityDirections = {};
  for (const axis of PERSONALITY_DIRECTION_AXES) {
    const raw = values[axis.sliderId];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      continue;
    }
    const slider = clampSlider(raw);
    if (slider < 50) {
      directions[axis.left] = (50 - slider) / 50;
    } else if (slider > 50) {
      directions[axis.right] = (slider - 50) / 50;
    }
  }
  if (Object.keys(directions).length === 0) {
    return undefined;
  }
  return directions;
}

export function parsePersonalitySliderSidecar(
  raw: string,
): Record<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      values[key] = value;
    }
  }
  return values;
}

export function readPersonalitySliderSidecar(
  workspaceDir: string,
): Record<string, number> | null {
  try {
    return parsePersonalitySliderSidecar(
      readFileSync(join(workspaceDir, PERSONALITY_SLIDERS_PATH), "utf-8"),
    );
  } catch {
    return null;
  }
}

export function resolveHostedDirections(args: {
  model: string;
  sliders: Record<string, number> | null | undefined;
}): PersonalityDirections | undefined {
  if (!isHostedSteeringModel(args.model)) {
    return undefined;
  }
  return mapPersonalitySlidersToDirections(args.sliders);
}

export function hostedDirectionsExtraBody(
  model: string,
  workspaceDir: string,
): Record<string, unknown> | undefined {
  const directions = resolveHostedDirections({
    model,
    sliders: readPersonalitySliderSidecar(workspaceDir),
  });
  if (!directions) {
    return undefined;
  }
  return { directions };
}
