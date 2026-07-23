// Contact events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`. Contact list/get/delete are served by the HTTP
// `contacts` routes, not by a client message.

import type { ContactRequestEvent } from "../../api/events/contact-request.js";
import type { ContactsChangedEvent } from "../../api/events/contacts-changed.js";

export type _ContactsServerMessages =
  | ContactsChangedEvent
  | ContactRequestEvent;
