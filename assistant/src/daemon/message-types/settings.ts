// Client settings: daemon-pushed configuration updates to connected clients.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`. Settings mutations (voice config, avatar generation)
// are served by the HTTP settings/avatar routes, not by client messages.

import type { AvatarUpdatedEvent } from "../../api/events/avatar-updated.js";
import type { ClientSettingsUpdateEvent } from "../../api/events/client-settings-update.js";
import type { ConfigChangedEvent } from "../../api/events/config-changed.js";
import type { SoundsConfigUpdatedEvent } from "../../api/events/sounds-config-updated.js";

export type _SettingsServerMessages =
  | ClientSettingsUpdateEvent
  | AvatarUpdatedEvent
  | ConfigChangedEvent
  | SoundsConfigUpdatedEvent;
