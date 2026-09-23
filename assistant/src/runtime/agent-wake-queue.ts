import { createKeyedSingleFlight } from "../util/single-flight.js";

export const runWakeSingleFlight = createKeyedSingleFlight();

export function hasPendingAgentWake(conversationId: string): boolean {
  return runWakeSingleFlight.isPending(conversationId);
}
