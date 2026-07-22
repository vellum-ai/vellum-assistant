// Service-group upgrade lifecycle events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`.

import type { ServiceGroupUpdateCompleteEvent } from "../../api/events/service-group-update-complete.js";
import type { ServiceGroupUpdateProgressEvent } from "../../api/events/service-group-update-progress.js";
import type { ServiceGroupUpdateStartingEvent } from "../../api/events/service-group-update-starting.js";

export type _UpgradesServerMessages =
  | ServiceGroupUpdateStartingEvent
  | ServiceGroupUpdateProgressEvent
  | ServiceGroupUpdateCompleteEvent;
