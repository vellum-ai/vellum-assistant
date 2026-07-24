// Workspace identity events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file composes them into the domain union consumed by
// `message-protocol.ts`. Workspace file listing/reading, identity retrieval,
// tool-permission simulation, and tool-name listing are served by the HTTP
// workspace / settings routes, not by client messages.

import type { IdentityChangedEvent } from "../../api/events/identity-changed.js";

export type _WorkspaceServerMessages = IdentityChangedEvent;
