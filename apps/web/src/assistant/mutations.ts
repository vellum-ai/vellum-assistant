/**
 * TanStack Query mutations for assistant lifecycle transitions.
 *
 * Three terminal-shape actions today:
 *
 *   - `useHatchAssistant`  — POST `/assistant/hatch/` to create a new
 *                            assistant (optionally pinned to a version
 *                            in nonprod / version-selection flows).
 *   - `useRetireAssistant` — POST `/assistant/{id}/retire/` to tear down
 *                            an existing assistant. Used by the stuck-
 *                            `initializing` recovery path and by the
 *                            settings panel's "reset" action.
 *
 * Both wrap the corresponding `assistant/api.ts` calls so callers get
 * idle/pending state, error surfaces, and `mutateAsync` for sequential
 * orchestration without each call site re-implementing it.
 *
 * The lifecycle hook orchestrates retries / generation counters; these
 * mutations stay dumb on purpose — no implicit retry, no Sentry
 * capture. That separation keeps the recovery state machine in one
 * place where it can reason about hatch + retire in concert.
 */

import { useMutation } from "@tanstack/react-query";

import {
  hatchAssistant,
  retireAssistantById,
  type HatchInput,
  type HatchResult,
  type RetireResult,
} from "@/assistant/api";

export function useHatchAssistant() {
  return useMutation<HatchResult, Error, HatchInput | undefined>({
    mutationFn: (input) => hatchAssistant(input),
  });
}

export function useRetireAssistant() {
  return useMutation<RetireResult, Error, string>({
    mutationFn: (assistantId) => retireAssistantById(assistantId),
  });
}
