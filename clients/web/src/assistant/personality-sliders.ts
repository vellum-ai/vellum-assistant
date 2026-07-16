/**
 * Persistence for the personality slider values — shared by research
 * onboarding's "Create my personality" step and the About Assistant
 * personality page.
 *
 * The rewrite prompt carries the values into the assistant's identity
 * files as prose, so the raw dial positions would otherwise be lost the
 * moment the page unmounts. They're kept as a JSON sidecar in the
 * assistant's workspace (like the avatar's `character-traits.json`), so
 * the sliders reopen where the user left them — on any device — and the
 * overview's Personality card can plot them as a radar.
 */

import { workspaceFileGet, workspaceWritePost } from "@/generated/daemon/sdk.gen";
import { assertHasResponse } from "@/utils/api-errors";

import { PERSONALITY_AXIS_IDS } from "./personality-rewrite";

export const PERSONALITY_SLIDERS_PATH = "data/personality-sliders.json";

/** Sliders start centered — no axis is nudged either way until the user acts. */
export const PERSONALITY_SLIDER_DEFAULT = 50;

export type PersonalitySliderValues = Record<string, number>;

export function personalitySlidersQueryKey(assistantId: string) {
  return ["personality-sliders", assistantId] as const;
}

function isSliderValues(value: unknown): value is PersonalitySliderValues {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((v) => typeof v === "number");
}

/**
 * Fill every axis so untouched sliders persist their centered default —
 * a partial record would reopen with a mix of saved and phantom values
 * after the axis list changes.
 */
export function completeSliderValues(
  values: PersonalitySliderValues,
): PersonalitySliderValues {
  return Object.fromEntries(
    Object.values(PERSONALITY_AXIS_IDS).map((axisId) => [
      axisId,
      values[axisId] ?? PERSONALITY_SLIDER_DEFAULT,
    ]),
  );
}

/** Resolves `null` when the sidecar is missing or unreadable; never throws. */
export async function fetchPersonalitySliders(
  assistantId: string,
): Promise<PersonalitySliderValues | null> {
  try {
    const { data, error, response } = await workspaceFileGet({
      path: { assistant_id: assistantId },
      query: { path: PERSONALITY_SLIDERS_PATH },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch personality sliders");
    if (!response.ok || !data) {
      return null;
    }
    const parsed: unknown = JSON.parse(data.content);
    if (!isSliderValues(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Best-effort write; resolves `false` on failure, never throws. */
export async function savePersonalitySliders(
  assistantId: string,
  values: PersonalitySliderValues,
): Promise<boolean> {
  try {
    const { error, response } = await workspaceWritePost({
      path: { assistant_id: assistantId },
      body: {
        path: PERSONALITY_SLIDERS_PATH,
        content: JSON.stringify(values, null, 2),
        encoding: "utf-8",
      },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to save personality sliders");
    return response.ok;
  } catch {
    return false;
  }
}
