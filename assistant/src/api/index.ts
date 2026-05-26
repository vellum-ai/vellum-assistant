import { z } from "zod";

import { RelationshipStateUpdatedEventSchema } from "./events/relationship-state-updated.js";

export {
  type RelationshipStateUpdatedEvent,
  RelationshipStateUpdatedEventSchema,
} from "./events/relationship-state-updated.js";

/**
 * Canonical SSE event schema for the assistant runtime.
 *
 * Discriminated union over the `type` field. Each member is the
 * canonical wire-contract schema for a single event type, defined
 * alongside the daemon code that emits it. Consumers (web client,
 * gateway, evals) parse incoming events with this single schema
 * rather than maintaining their own dispatch table.
 *
 * Add new events by exporting their schema from `./events/` and
 * appending them to the union below.
 */
export const AssistantEventSchema = z.discriminatedUnion("type", [
  RelationshipStateUpdatedEventSchema,
]);
