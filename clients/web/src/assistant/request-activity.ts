import { create } from "zustand";

export interface AssistantRequestObservation {
  assistantId: string;
  generation: number;
  sequence: number;
}

// Client observations only. Server status stays in the query cache.
interface AssistantRequestActivity {
  assistantId: string | null;
  generation: number;
  lastSuccess: number;
  lastStatus: number;
}

let sequence = 0;
export const useAssistantRequestActivity = create<AssistantRequestActivity>(
  () => ({ assistantId: null, generation: 0, lastSuccess: 0, lastStatus: 0 }),
);

export function resetAssistantRequestActivity(
  assistantId: string | null,
): void {
  useAssistantRequestActivity.setState((state) => ({
    assistantId,
    generation: state.generation + 1,
    lastSuccess: 0,
    lastStatus: 0,
  }));
}

/** Capture before awaiting so late responses cannot undo newer status checks. */
export function beginAssistantRequest(
  assistantId: string,
): AssistantRequestObservation | null {
  const state = useAssistantRequestActivity.getState();
  return state.assistantId === assistantId
    ? { assistantId, generation: state.generation, sequence: ++sequence }
    : null;
}

function isCurrent(observation: AssistantRequestObservation): boolean {
  const state = useAssistantRequestActivity.getState();
  return (
    state.assistantId === observation.assistantId &&
    state.generation === observation.generation
  );
}

export function recordAssistantRequestSuccess(
  observation: AssistantRequestObservation | null,
): void {
  if (
    observation &&
    isCurrent(observation) &&
    observation.sequence > useAssistantRequestActivity.getState().lastSuccess
  ) {
    useAssistantRequestActivity.setState({ lastSuccess: observation.sequence });
  }
}

export function recordAssistantStatusObservation(
  observation: AssistantRequestObservation | null,
): void {
  if (
    observation &&
    isCurrent(observation) &&
    observation.sequence > useAssistantRequestActivity.getState().lastStatus
  ) {
    useAssistantRequestActivity.setState({ lastStatus: observation.sequence });
  }
}

export function hasAssistantRespondedSince(
  observation: AssistantRequestObservation | null,
): boolean {
  return (
    observation !== null &&
    isCurrent(observation) &&
    useAssistantRequestActivity.getState().lastSuccess > observation.sequence
  );
}

export function useAssistantRespondedSinceStatus(
  assistantId: string | null,
): boolean {
  return useAssistantRequestActivity(
    (state) =>
      assistantId !== null &&
      state.assistantId === assistantId &&
      state.lastSuccess > state.lastStatus,
  );
}
