// External service integrations: Slack, Telegram, Vercel, ingress, platform.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file composes them into the domain union consumed by
// `message-protocol.ts`. Config get/set flows (Slack webhook, ingress,
// platform, Vercel, Telegram, integration listing and connect) and channel
// verification are served by the HTTP settings / channel-verification routes,
// not by client messages.

import type { NavigateSettingsEvent } from "../../api/events/navigate-settings.js";
import type { OAuthConnectResultEvent } from "../../api/events/oauth-connect-result.js";
import type { OpenPanelEvent } from "../../api/events/open-panel.js";
import type { OpenUrlEvent } from "../../api/events/open-url.js";
import type { PlatformDisconnectedEvent } from "../../api/events/platform-disconnected.js";
import type { ShowPlatformLoginEvent } from "../../api/events/show-platform-login.js";

// --- Domain-level union alias (consumed by the barrel file) ---

export type _IntegrationsServerMessages =
  | OAuthConnectResultEvent
  | OpenUrlEvent
  | OpenPanelEvent
  | NavigateSettingsEvent
  | ShowPlatformLoginEvent
  | PlatformDisconnectedEvent;
