import type { RouteDefinition } from "../types.js";
import { ROUTES as FORCE_COMPACT_ROUTES } from "./force-compact.js";
import { ROUTES as INJECT_FAILURES_ROUTES } from "./inject-failures.js";
import { ROUTES as RESET_CIRCUIT_ROUTES } from "./reset-circuit.js";
import { ROUTES as SEED_CONVERSATION_ROUTES } from "./seed-conversation.js";
import { ROUTES as SEEDED_CONVERSATIONS_ROUTES } from "./seeded-conversations.js";
import { ROUTES as STATE_ROUTES } from "./state.js";

export const ROUTES: RouteDefinition[] = [
  ...FORCE_COMPACT_ROUTES,
  ...INJECT_FAILURES_ROUTES,
  ...RESET_CIRCUIT_ROUTES,
  ...SEED_CONVERSATION_ROUTES,
  ...SEEDED_CONVERSATIONS_ROUTES,
  ...STATE_ROUTES,
];
