import { create } from "zustand";

let sequence = 0;
export const useAssistantRequestActivity = create(() => ({
  assistantId: null as string | null,
  sequence: 0,
  responded: false,
}));

export function resetAssistantRequestActivity(
  assistantId: string | null,
): void {
  // Advancing the sequence also rejects responses from a previous selection.
  useAssistantRequestActivity.setState({
    assistantId,
    sequence: ++sequence,
    responded: false,
  });
}

// Capture before awaiting so late responses cannot undo newer observations.
export function beginAssistantRequest(assistantId: string): number | null {
  const state = useAssistantRequestActivity.getState();
  return state.assistantId === assistantId ? ++sequence : null;
}

export function recordAssistantResponse(
  observation: number | null,
  responded: boolean,
): boolean {
  const state = useAssistantRequestActivity.getState();
  if (observation === null || observation <= state.sequence) {
    return false;
  }
  useAssistantRequestActivity.setState({
    sequence: observation,
    responded,
  });
  return true;
}

export function hasAssistantRespondedSince(
  observation: number | null,
): boolean {
  const state = useAssistantRequestActivity.getState();
  return (
    observation !== null && state.responded && state.sequence > observation
  );
}

export function useAssistantRespondedSinceStatus(
  assistantId: string | null,
): boolean {
  return useAssistantRequestActivity(
    (state) =>
      assistantId !== null &&
      state.assistantId === assistantId &&
      state.responded,
  );
}
